/**
 * 状态层 —— 权威状态的唯一持有者与唯一写入通道。
 *
 * 核心约束：
 *   1. **引擎持有权威状态**。外部来源（包括未来的模型）只能提交 effects 申请，
 *      由本模块判定合法后写入。没有第二条写路径。
 *   2. **不可变**。每次写入产出新状态对象，旧对象原样保留（回档靠它）。
 *   3. **数值写入自动 clamp**。越界不是报错而是夹紧，但要留下痕迹
 *      （changes 里标 clamped），否则漂移查不出来。
 *   4. **确定性**。同一状态 + 同一 effects 序列 → 逐字节相同的输出。
 */

import { splitPath } from './condition.js';
import { ROUTE_STATES } from './schema.js';

/** 声明式数值路径：写入后要按 bounds 夹紧 */
const STAT_PATH_RE = /^actors\.([^.]+)\.stats\.([^.]+)$/;
/** 路线路径：写入值必须是合法路线状态 */
const ROUTE_PATH_RE = /^routes\.([^.]+)$/;

export class StateError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'StateError';
    this.detail = detail;
  }
}

/** 深拷贝状态（Node 17+ / 现代浏览器都有 structuredClone） */
export function cloneState(state) {
  return structuredClone(state);
}

/**
 * 定位写入目标：返回父容器、键名、写入前的值
 * @returns {{ parent: object, key: string|number, before: unknown } | null}
 */
function locate(root, path) {
  const segs = splitPath(path);
  if (!segs || segs.length === 0) return null;

  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    if ('key' in seg) {
      if (!Object.prototype.hasOwnProperty.call(cur, seg.key)) return null;
      cur = cur[seg.key];
    } else {
      if (!(seg.index in cur)) return null;
      cur = cur[seg.index];
    }
  }

  if (cur === null || typeof cur !== 'object') return null;

  const last = segs[segs.length - 1];
  const key = 'key' in last ? last.key : last.index;
  const exists = Object.prototype.hasOwnProperty.call(cur, key);

  return { parent: cur, key, before: exists ? cur[key] : undefined, exists };
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 在已克隆的状态上就地执行一条 effect。
 * @returns {{path: string, op: string, from: unknown, to: unknown, clamped?: object, skipped?: string}}
 */
export function applyEffectInPlace(state, effect) {
  const { path, op, value } = effect;
  const spot = locate(state, path);

  if (spot === null) {
    throw new StateError(`效果路径无法定位：${path}`, { path, op });
  }

  const { parent, key, before, exists } = spot;
  // value 单独留着：push/pull 需要知道"动的是哪一个"，光看 from/to 分不出来
  const change = { path, op, from: before, to: before, value, skipped: undefined };

  // 运算类操作先挡住非有限数：NaN / Infinity 参与运算后会静默污染状态，
  // 而且在 JSON 里会变成 null，问题要到很后面才暴露。
  if (['add', 'sub', 'mul'].includes(op) && !isFiniteNumber(value)) {
    throw new StateError(`操作符 ${op} 的 value 必须是有限数字，收到 ${String(value)}`, { path, op, value });
  }

  switch (op) {
    case 'set': {
      change.to = value;
      break;
    }
    case 'add':
    case 'sub':
    case 'mul': {
      const base = exists ? before : 0;
      if (!isFiniteNumber(base)) {
        throw new StateError(`操作符 ${op} 需要数值目标，${path} 当前为 ${typeof before}`, { path, op, before });
      }
      change.to = op === 'add' ? base + value : op === 'sub' ? base - value : base * value;
      break;
    }
    case 'clamp': {
      const base = exists ? before : 0;
      if (!isFiniteNumber(base)) {
        throw new StateError(`clamp 需要数值目标，${path} 当前为 ${typeof before}`, { path, op, before });
      }
      const raw = Math.min(Math.max(base, value.min), value.max);
      if (raw !== base) change.clamped = { min: value.min, max: value.max, raw: base, reason: 'clamp-effect' };
      change.to = raw;
      break;
    }
    case 'push': {
      const arr = exists ? before : [];
      if (!Array.isArray(arr)) {
        throw new StateError(`push 需要数组目标，${path} 当前为 ${typeof before}`, { path, op, before });
      }
      // 幂等：重复 push 同一元素不产生第二次写入
      if (arr.includes(value)) {
        change.to = arr.slice();
        change.skipped = 'duplicate';
      } else {
        change.to = [...arr, value];
      }
      break;
    }
    case 'pull': {
      const arr = exists ? before : [];
      if (!Array.isArray(arr)) {
        throw new StateError(`pull 需要数组目标，${path} 当前为 ${typeof before}`, { path, op, before });
      }
      change.to = arr.filter(x => x !== value);
      break;
    }
    case 'toggle': {
      const base = exists ? before : false;
      if (typeof base !== 'boolean') {
        throw new StateError(`toggle 需要布尔目标，${path} 当前为 ${typeof before}`, { path, op, before });
      }
      change.to = !base;
      break;
    }
    default:
      throw new StateError(`未知操作符：${op}`, { path, op });
  }

  // 声明式数值：按 bounds 夹紧（越界记为 clamped，不静默）
  const statHit = STAT_PATH_RE.exec(path);
  if (statHit) {
    const [, actorId, statKey] = statHit;
    const bounds = state.actors?.[actorId]?.bounds?.[statKey];
    if (!bounds) {
      throw new StateError(`数值缺少边界声明：${path}（不允许写入未声明的数值）`, { path });
    }
    const raw = change.to;
    if (!isFiniteNumber(raw)) {
      throw new StateError(`数值写入结果不是有限数字：${path} → ${String(raw)}`, { path, to: raw });
    }
    if (raw < bounds.min || raw > bounds.max) {
      change.to = Math.min(Math.max(raw, bounds.min), bounds.max);
      change.clamped = { min: bounds.min, max: bounds.max, raw, reason: 'out-of-bounds' };
    }
  }

  // 路线状态：值域校验
  const routeHit = ROUTE_PATH_RE.exec(path);
  if (routeHit && !ROUTE_STATES.includes(change.to)) {
    throw new StateError(`路线状态非法：${path} → ${JSON.stringify(change.to)}，允许 ${ROUTE_STATES.join(' / ')}`, { path, to: change.to });
  }

  if (!change.skipped && change.to === before && !change.clamped) {
    // 无变化，但仍要保证目标存在（set 同值 / 重复 push）
    change.skipped = 'no-change';
  }

  parent[key] = change.to;
  return change;
}

/**
 * 批量应用 effects（主入口）
 * @returns {{ state: object, changes: object[] }}
 */
export function applyEffects(state, effects = []) {
  const next = cloneState(state);
  const changes = [];
  for (const eff of effects) {
    changes.push(applyEffectInPlace(next, eff));
  }
  return { state: next, changes };
}

/**
 * 路线回退一格（对应「撤回后公开关系回退一格」的机制）
 */
export const ROUTE_STEP_DOWN = Object.freeze({
  advancing: 'open',
  open: 'closed',
  frozen: 'closed',
  settled: 'settled',
  closed: 'closed',
});

export function stepDownRoute(from) {
  return ROUTE_STEP_DOWN[from] ?? 'closed';
}

/* ------------------------------------------------------------------ *
 * 稳定序列化与指纹（跨环境，不依赖 node:crypto）
 * ------------------------------------------------------------------ */

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 状态指纹：用于验证「同输入同输出」 */
export function hashState(state) {
  return fnv1a(stableStringify(state));
}

/* ------------------------------------------------------------------ *
 * 增量日志
 * ------------------------------------------------------------------ */

/** 把 changes 压成人可读的一行行文本 */
export function formatChanges(changes) {
  const lines = [];
  for (const c of changes) {
    const from = c.op === 'push' || c.op === 'pull' ? '' : `${brief(c.from)} → `;
    let line = `  ${c.path}: ${from}${brief(c.to)}`;
    if (c.clamped) line += `  [夹紧 ${brief(c.clamped.raw)} ∈ ${c.clamped.min}..${c.clamped.max}]`;
    if (c.skipped) line += '  [无变化]';
    lines.push(line);
  }
  return lines.join('\n');
}

function brief(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return `[${v.join(',')}]`;
  if (v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* ------------------------------------------------------------------ *
 * Store：持有状态 + 快照栈（第 4 期在此之上做存档）
 * ------------------------------------------------------------------ */

export function createStore(initialState, options = {}) {
  const maxSnapshots = options.maxSnapshots ?? 500;
  let state = cloneState(initialState);
  /** @type {object[]} snapshots[0] 为初始状态，之后每 dispatch 一次追加 */
  const timeline = [cloneState(state)];

  function pushSnapshot() {
    timeline.push(cloneState(state));
    if (timeline.length > maxSnapshots) timeline.shift();
  }

  return {
    getState: () => cloneState(state),

    dispatch(effects) {
      const result = applyEffects(state, effects);
      state = result.state;
      pushSnapshot();
      return result;
    },

    /**
     * 直接提交一个新状态并留快照（时间推进、引擎接管状态时用，回档仍可用）
     */
    commit(nextState) {
      state = cloneState(nextState);
      pushSnapshot();
      return cloneState(state);
    },

    /**
     * 替换整个状态并重置时间线（读档用）。
     * @param {object} nextState
     * @param {object[]} [snapshots] 一并恢复的历史快照；省略则时间线只剩当前状态
     */
    replace(nextState, snapshots) {
      timeline.length = 0;
      if (Array.isArray(snapshots) && snapshots.length > 0) {
        for (const s of snapshots) timeline.push(cloneState(s));
        state = cloneState(timeline[timeline.length - 1]);
      } else {
        state = cloneState(nextState);
        timeline.push(cloneState(state));
      }
      return cloneState(state);
    },

    /** 回退 steps 步；步数不足返回 false */
    rollback(steps = 1) {
      if (!Number.isInteger(steps) || steps < 1) {
        throw new RangeError(`rollback 步数必须为正整数，收到 ${steps}`);
      }
      if (timeline.length - 1 < steps) return false;
      timeline.length = timeline.length - steps;
      state = cloneState(timeline[timeline.length - 1]);
      return true;
    },

    /** 可回退的最大步数 */
    depth: () => timeline.length - 1,

    snapshotAt: (i) => (i >= 0 && i < timeline.length ? cloneState(timeline[i]) : undefined),

    allSnapshots: () => timeline.map(cloneState),
  };
}
