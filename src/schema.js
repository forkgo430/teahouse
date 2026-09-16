/**
 * 数据契约 —— 全项目的唯一真相源。
 *
 * 本文件只做两件事：
 *   1. 声明每个实体的字段规范（常量 + JSDoc 类型）；
 *   2. 提供运行时校验，把「看起来对」的数据挡在引擎外面。
 *
 * 设计原则：校验必须报出**字段路径 + 原因**，绝不静默通过。
 * 静默通过的数据会在若干轮之后变成难查的数值漂移，代价远高于当场报错。
 */

export const SCHEMA_VERSION = 1;

/** 时段枚举（顺序即推进顺序） */
export const SLOTS = ['dawn', 'morning', 'afternoon', 'evening', 'night'];

/** 路线状态机取值 */
export const ROUTE_STATES = ['closed', 'open', 'advancing', 'frozen', 'settled'];

/** 路线状态的显示名（给界面与提示词用，不参与判定） */
export const ROUTE_LABELS = Object.freeze({
  closed: '未开启',
  open: '已开启',
  advancing: '推进中',
  frozen: '已冻结',
  settled: '已定局',
});

/** 效果允许的操作符 */
export const EFFECT_OPS = ['set', 'add', 'sub', 'mul', 'clamp', 'push', 'pull', 'toggle'];

/** 条件允许的比较运算符 */
export const CMP_OPS = ['==', '!=', '>', '>=', '<', '<=', 'contains', 'in', 'exists'];

/** 分支 unlock 只允许出现的键 */
export const UNLOCK_KEYS = ['clue', 'flag', 'achievement', 'ending', 'route'];

/** 数值默认边界 */
export const STAT_DEFAULTS = Object.freeze({ min: 0, max: 100, init: 50 });

/** 默认时钟 */
export const DEFAULT_CLOCK = Object.freeze({ day: 1, slot: 'night' });

/**
 * @typedef {{ path: string, message: string }} SchemaIssue
 */

export class SchemaError extends Error {
  /** @param {SchemaIssue[]} issues */
  constructor(issues) {
    const body = issues.map((it, i) => `  ${i + 1}. ${it.path} — ${it.message}`).join('\n');
    super(`数据契约校验失败（${issues.length} 处）：\n${body}`);
    this.name = 'SchemaError';
    this.issues = issues;
  }
}

const issue = (path, message) => ({ path, message });

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function isNonEmptyArray(v) {
  return Array.isArray(v) && v.length > 0;
}

/** 字段路径：以点号分隔的非空段，允许 [n] 下标 */
function checkPathSegments(p, path, issues) {
  if (!isNonEmptyString(p)) {
    issues.push(issue(path, '必须是字段路径字符串，如 stats.lin.trust'));
    return;
  }
  const bad = p.split('.').filter(seg => seg.trim() === '');
  if (bad.length > 0) {
    issues.push(issue(path, `路径含空段：${JSON.stringify(p)}`));
  }
}

function checkStringArray(v, path, issues, { nonEmpty = false } = {}) {
  if (!Array.isArray(v)) {
    issues.push(issue(path, '必须是字符串数组'));
    return;
  }
  if (nonEmpty && v.length === 0) {
    issues.push(issue(path, '不能是空数组'));
  }
  v.forEach((item, i) => {
    if (!isNonEmptyString(item)) {
      issues.push(issue(`${path}[${i}]`, '必须是非空字符串'));
    }
  });
}

/* ------------------------------------------------------------------ *
 * 条件
 * ------------------------------------------------------------------ */

/**
 * 条件表达式（递归）
 *   null                                    恒真（表示「无前置」）
 *   { all: [cond, ...] }                    全部成立
 *   { any: [cond, ...] }                    任一成立
 *   { not: cond }                           取反
 *   { path, op, value }                     原子比较
 *
 * 硬约束：不允许出现需要语义理解的字段。所有条件必须可判定。
 */
export function validateCondition(cond, path, issues) {
  if (cond === null || cond === undefined) return;

  if (!isPlainObject(cond)) {
    issues.push(issue(path, `条件必须是对象或 null，收到 ${Array.isArray(cond) ? '数组' : typeof cond}`));
    return;
  }

  const keys = Object.keys(cond);
  if (keys.length === 0) {
    issues.push(issue(path, '空条件对象无意义；恒真请写 null，恒假请写 { not: null } 之外的可判定条件'));
    return;
  }

  if ('all' in cond) {
    if (!isNonEmptyArray(cond.all)) {
      issues.push(issue(`${path}.all`, 'all 必须是非空数组'));
    } else {
      cond.all.forEach((c, i) => validateCondition(c, `${path}.all[${i}]`, issues));
    }
    return;
  }

  if ('any' in cond) {
    if (!isNonEmptyArray(cond.any)) {
      issues.push(issue(`${path}.any`, 'any 必须是非空数组'));
    } else {
      cond.any.forEach((c, i) => validateCondition(c, `${path}.any[${i}]`, issues));
    }
    return;
  }

  if ('not' in cond) {
    validateCondition(cond.not, `${path}.not`, issues);
    return;
  }

  // 原子条件
  checkPathSegments(cond.path, `${path}.path`, issues);

  if (!isNonEmptyString(cond.op)) {
    issues.push(issue(`${path}.op`, `原子条件必须给 op，允许：${CMP_OPS.join(' / ')}`));
    return;
  }
  if (!CMP_OPS.includes(cond.op)) {
    issues.push(issue(`${path}.op`, `未知运算符 ${JSON.stringify(cond.op)}，允许：${CMP_OPS.join(' / ')}`));
    return;
  }

  if (cond.op === 'exists') {
    if ('value' in cond) {
      issues.push(issue(`${path}.value`, 'exists 不接受 value'));
    }
    return;
  }

  if (!('value' in cond)) {
    issues.push(issue(`${path}.value`, `运算符 ${cond.op} 必须带 value`));
    return;
  }

  if (['>', '>=', '<', '<='].includes(cond.op) && typeof cond.value !== 'number') {
    issues.push(issue(`${path}.value`, `运算符 ${cond.op} 的 value 必须是数字`));
  }

  if (['contains', 'in'].includes(cond.op) && cond.value === undefined) {
    issues.push(issue(`${path}.value`, `运算符 ${cond.op} 的 value 不能为 undefined`));
  }
}

/* ------------------------------------------------------------------ *
 * 效果
 * ------------------------------------------------------------------ */

/**
 * 效果 = 一次状态写入申请。引擎是唯一执行者，模型无权直接改状态。
 *   { path, op: 'add', value: 5 }
 *   { path: 'flags.x', op: 'set', value: true }
 *   { path: 'clues', op: 'push', value: 'C03' }
 *   { path: 'flags.x', op: 'toggle' }
 */
export function validateEffect(eff, path, issues) {
  if (!isPlainObject(eff)) {
    issues.push(issue(path, '效果必须是对象'));
    return;
  }

  checkPathSegments(eff.path, `${path}.path`, issues);

  if (!EFFECT_OPS.includes(eff.op)) {
    issues.push(issue(`${path}.op`, `未知操作符 ${JSON.stringify(eff.op)}，允许：${EFFECT_OPS.join(' / ')}`));
    return;
  }

  if (eff.op === 'toggle') {
    if ('value' in eff && typeof eff.value !== 'boolean') {
      issues.push(issue(`${path}.value`, 'toggle 的 value（若给）必须是布尔值'));
    }
    return;
  }

  if (!('value' in eff)) {
    issues.push(issue(`${path}.value`, `操作符 ${eff.op} 必须带 value`));
    return;
  }

  if (['add', 'sub', 'mul'].includes(eff.op) && !Number.isFinite(eff.value)) {
    issues.push(issue(`${path}.value`,
      `操作符 ${eff.op} 的 value 必须是有限数字，收到 ${String(eff.value)}（NaN / Infinity 会静默污染状态）`));
  }
  if (eff.op === 'clamp' && !(isPlainObject(eff.value) && typeof eff.value.min === 'number' && typeof eff.value.max === 'number')) {
    issues.push(issue(`${path}.value`, 'clamp 的 value 必须是 { min: number, max: number }'));
  }
  if (eff.op === 'clamp' && isPlainObject(eff.value) && eff.value.min > eff.value.max) {
    issues.push(issue(`${path}.value`, `clamp 的 min(${eff.value.min}) 不能大于 max(${eff.value.max})`));
  }
}

/* ------------------------------------------------------------------ *
 * 分支
 * ------------------------------------------------------------------ */

export function validateBranch(branch, path, issues) {
  if (!isPlainObject(branch)) {
    issues.push(issue(path, '分支必须是对象'));
    return;
  }

  if (!isNonEmptyString(branch.key)) {
    issues.push(issue(`${path}.key`, '分支必须有 key'));
  } else if (!/^[A-Za-z0-9_]+$/.test(branch.key)) {
    issues.push(issue(`${path}.key`, `key 只允许字母/数字/下划线，收到 ${JSON.stringify(branch.key)}`));
  }

  if (typeof branch.text !== 'string') {
    issues.push(issue(`${path}.text`, '分支必须有 text 字段（待补写时给空字符串，不要省略）'));
  }

  validateCondition(branch.cond, `${path}.cond`, issues);

  if (branch.effects !== undefined) {
    if (!Array.isArray(branch.effects)) {
      issues.push(issue(`${path}.effects`, 'effects 必须是数组'));
    } else {
      branch.effects.forEach((e, i) => validateEffect(e, `${path}.effects[${i}]`, issues));
    }
  }

  if (branch.unlock !== undefined) {
    if (!isPlainObject(branch.unlock)) {
      issues.push(issue(`${path}.unlock`, 'unlock 必须是对象'));
    } else {
      for (const k of Object.keys(branch.unlock)) {
        if (!UNLOCK_KEYS.includes(k)) {
          issues.push(issue(`${path}.unlock.${k}`, `未知解锁类型，允许：${UNLOCK_KEYS.join(' / ')}`));
        }
      }
      if ('route' in branch.unlock) {
        const r = branch.unlock.route;
        if (!isPlainObject(r) || !isNonEmptyString(r.actor) || !ROUTE_STATES.includes(r.state)) {
          issues.push(issue(`${path}.unlock.route`,
            `route 必须是 { actor, state }，state ∈ ${ROUTE_STATES.join(' / ')}`));
        }
      }
    }
  }

  if (branch.next !== undefined && !isPlainObject(branch.next)) {
    issues.push(issue(`${path}.next`, 'next 必须是对象'));
  }

  // 自由输入匹配用的关键词。可选：不给则该分支只能靠点选或输入 key 进入。
  if (branch.keywords !== undefined) {
    checkStringArray(branch.keywords, `${path}.keywords`, issues, { nonEmpty: true });
  }

  // 该分支涉及关系推进，必须拿到对应角色的当轮同意（由边界的 guard 强制）
  if (branch.requiresConsent !== undefined && !isNonEmptyString(branch.requiresConsent)) {
    issues.push(issue(`${path}.requiresConsent`, 'requiresConsent 必须是角色 id（字符串）'));
  }
}

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

export function validateEvent(event, path = 'event', issues = []) {
  if (!isPlainObject(event)) {
    issues.push(issue(path, '事件必须是对象'));
    return issues;
  }

  if (!isNonEmptyString(event.id)) {
    issues.push(issue(`${path}.id`, '事件必须有 id'));
  } else if (!/^[A-Za-z0-9_-]+$/.test(event.id)) {
    issues.push(issue(`${path}.id`, `id 只允许字母/数字/下划线/连字符，收到 ${JSON.stringify(event.id)}`));
  }

  if (!isNonEmptyString(event.title)) {
    issues.push(issue(`${path}.title`, '事件必须有 title'));
  }

  // when：命中时机
  if (event.when !== undefined) {
    if (!isPlainObject(event.when)) {
      issues.push(issue(`${path}.when`, 'when 必须是对象'));
    } else {
      if ('day' in event.when) {
        const d = event.when.day;
        const ok = (typeof d === 'number' && Number.isInteger(d) && d >= 0)
          || (Array.isArray(d) && d.length > 0 && d.every(x => Number.isInteger(x) && x >= 0));
        if (!ok) issues.push(issue(`${path}.when.day`, 'day 必须是非负整数或非空整数数组'));
      }
      if ('slot' in event.when) {
        const s = event.when.slot;
        const arr = Array.isArray(s) ? s : [s];
        if (arr.length === 0) {
          issues.push(issue(`${path}.when.slot`, 'slot 不能是空数组'));
        } else {
          arr.forEach((x, i) => {
            if (!SLOTS.includes(x)) {
              issues.push(issue(Array.isArray(s) ? `${path}.when.slot[${i}]` : `${path}.when.slot`,
                `未知时段 ${JSON.stringify(x)}，允许：${SLOTS.join(' / ')}`));
            }
          });
        }
      }
    }
  }

  // where
  if (event.where !== undefined) {
    if (typeof event.where === 'string') {
      if (!isNonEmptyString(event.where)) issues.push(issue(`${path}.where`, 'where 不能是空字符串'));
    } else if (Array.isArray(event.where)) {
      checkStringArray(event.where, `${path}.where`, issues, { nonEmpty: true });
    } else {
      issues.push(issue(`${path}.where`, 'where 必须是字符串或字符串数组'));
    }
  }

  // priority
  if (event.priority !== undefined && !Number.isFinite(event.priority)) {
    issues.push(issue(`${path}.priority`, 'priority 必须是有限数字'));
  }

  // actors / firstMet
  if (event.actors !== undefined) {
    checkStringArray(event.actors, `${path}.actors`, issues, { nonEmpty: true });
  }
  if (event.firstMet !== undefined) {
    checkStringArray(event.firstMet, `${path}.firstMet`, issues, { nonEmpty: true });
    if (Array.isArray(event.actors) && Array.isArray(event.firstMet)) {
      event.firstMet.forEach((a, i) => {
        if (!event.actors.includes(a)) {
          issues.push(issue(`${path}.firstMet[${i}]`, `首出场角色 ${JSON.stringify(a)} 不在 actors 里`));
        }
      });
    }
  }

  validateCondition(event.require, `${path}.require`, issues);

  // branches
  if (!isNonEmptyArray(event.branches)) {
    issues.push(issue(`${path}.branches`, '事件必须至少有一个分支'));
  } else {
    const seen = new Set();
    event.branches.forEach((b, i) => {
      validateBranch(b, `${path}.branches[${i}]`, issues);
      if (isPlainObject(b) && isNonEmptyString(b.key)) {
        if (seen.has(b.key)) {
          issues.push(issue(`${path}.branches[${i}].key`, `分支 key 重复：${JSON.stringify(b.key)}`));
        }
        seen.add(b.key);
      }
    });

    // 无条件分支可以有多个（玩家面前就是并列选项），
    // 但「自动回落」时必须知道选谁，所以要求显式给 fallback。
    const unconditioned = event.branches.filter(b => isPlainObject(b) && (b.cond === undefined || b.cond === null));
    if (unconditioned.length > 1 && event.fallback === undefined) {
      issues.push(issue(`${path}.branches`,
        `有 ${unconditioned.length} 个无条件分支（${unconditioned.map(b => b.key).join(', ')}），自动回落目标不唯一，请显式指定 fallback`));
    }

    // fallback 必须指向存在的分支
    if (event.fallback !== undefined) {
      if (!isNonEmptyString(event.fallback)) {
        issues.push(issue(`${path}.fallback`, 'fallback 必须是分支 key'));
      } else if (!seen.has(event.fallback)) {
        issues.push(issue(`${path}.fallback`, `保底分支 ${JSON.stringify(event.fallback)} 不存在于 branches`));
      }
    }
  }

  if (event.tags !== undefined) {
    checkStringArray(event.tags, `${path}.tags`, issues);
  }

  if (event.repeat !== undefined && typeof event.repeat !== 'boolean') {
    issues.push(issue(`${path}.repeat`, 'repeat 必须是布尔值（默认 false，即只触发一次）'));
  }

  return issues;
}

/** 事件集合校验：额外查 id 全局唯一 */
export function validateEventSet(events) {
  const issues = [];
  if (!Array.isArray(events)) {
    return { ok: false, issues: [issue('events', '必须是数组')] };
  }
  const seen = new Map();
  events.forEach((ev, i) => {
    validateEvent(ev, `events[${i}]`, issues);
    if (isPlainObject(ev) && isNonEmptyString(ev.id)) {
      if (seen.has(ev.id)) {
        issues.push(issue(`events[${i}].id`, `事件 id 重复：${JSON.stringify(ev.id)}（首次出现于 events[${seen.get(ev.id)}]）`));
      } else {
        seen.set(ev.id, i);
      }
    }
  });
  return { ok: issues.length === 0, issues };
}

/** 单事件便捷入口 */
export function validateEventOnly(event) {
  const issues = validateEvent(event, 'event', []);
  return { ok: issues.length === 0, issues };
}

/** 断言：不通过直接抛 SchemaError（含字段路径与原因） */
export function assertEvent(event) {
  const issues = validateEvent(event, 'event', []);
  if (issues.length > 0) throw new SchemaError(issues);
  return true;
}

export function assertEventSet(events) {
  const { ok, issues } = validateEventSet(events);
  if (!ok) throw new SchemaError(issues);
  return true;
}

/* ------------------------------------------------------------------ *
 * 角色定义 / 初始状态
 * ------------------------------------------------------------------ */

/**
 * 角色定义
 * @param {object} def
 * @param {string} def.id
 * @param {string} def.name
 * @param {Array<{key: string, label?: string, min?: number, max?: number, init?: number}>} [def.stats]
 */
export function validateActorDef(def, path, issues) {
  if (!isPlainObject(def)) {
    issues.push(issue(path, '角色定义必须是对象'));
    return;
  }
  if (!isNonEmptyString(def.id)) {
    issues.push(issue(`${path}.id`, '角色必须有 id'));
  } else if (!/^[A-Za-z0-9_-]+$/.test(def.id)) {
    issues.push(issue(`${path}.id`, `id 只允许字母/数字/下划线/连字符，收到 ${JSON.stringify(def.id)}`));
  }
  if (!isNonEmptyString(def.name)) {
    issues.push(issue(`${path}.name`, '角色必须有 name'));
  }
  if (def.adult !== undefined && typeof def.adult !== 'boolean') {
    issues.push(issue(`${path}.adult`, 'adult 必须是布尔值（默认 true；显式标 false 的角色一律不允许推进）'));
  }
  if (def.stats !== undefined) {
    if (!Array.isArray(def.stats)) {
      issues.push(issue(`${path}.stats`, 'stats 必须是数组'));
    } else {
      const seen = new Set();
      def.stats.forEach((s, i) => {
        const sp = `${path}.stats[${i}]`;
        if (!isPlainObject(s)) { issues.push(issue(sp, '数值定义必须是对象')); return; }
        if (!isNonEmptyString(s.key)) issues.push(issue(`${sp}.key`, '数值必须有 key'));
        else if (seen.has(s.key)) issues.push(issue(`${sp}.key`, `数值 key 重复：${JSON.stringify(s.key)}`));
        else seen.add(s.key);

        const min = s.min ?? STAT_DEFAULTS.min;
        const max = s.max ?? STAT_DEFAULTS.max;
        const init = s.init ?? STAT_DEFAULTS.init;
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
          issues.push(issue(sp, 'min / max 必须是数字'));
        } else if (min > max) {
          issues.push(issue(sp, `min(${min}) 不能大于 max(${max})`));
        } else if (!Number.isFinite(init) || init < min || init > max) {
          issues.push(issue(`${sp}.init`, `init(${init}) 必须落在 [${min}, ${max}] 区间内`));
        }
      });
    }
  }
}

/**
 * 由角色定义生成初始状态（最小版本，第 2 期扩展）
 * @param {{ actors?: object[], clock?: {day:number, slot:string}, where?: string, ledger?: object }} [def]
 */
export function createInitialState(def = {}) {
  const actorDefs = def.actors ?? [];
  const issues = [];
  actorDefs.forEach((a, i) => validateActorDef(a, `actors[${i}]`, issues));
  if (issues.length > 0) throw new SchemaError(issues);

  const actors = {};
  for (const a of actorDefs) {
    const stats = {};
    const bounds = {};
    for (const s of (a.stats ?? [])) {
      const min = s.min ?? STAT_DEFAULTS.min;
      const max = s.max ?? STAT_DEFAULTS.max;
      const init = s.init ?? STAT_DEFAULTS.init;
      stats[s.key] = init;
      bounds[s.key] = { min, max };
    }
    actors[a.id] = {
      id: a.id,
      name: a.name,
      met: false,
      adult: a.adult !== false,
      stats,
      bounds,
    };
  }

  const clock = { ...DEFAULT_CLOCK, ...(def.clock ?? {}) };
  if (!SLOTS.includes(clock.slot)) {
    throw new SchemaError([issue('clock.slot', `未知时段 ${JSON.stringify(clock.slot)}，允许：${SLOTS.join(' / ')}`)]);
  }

  return {
    clock,
    where: def.where ?? null,
    actors,
    routes: {},
    // 当轮意愿与边界：每个角色一份，只在当轮有效，不自动延续
    consent: {},
    // 试探轨迹：用来判定「拒绝后是否在同一方向上反复纠缠」
    tracks: {},
    ledger: { cash: 0, income: 0, expense: 0, ...(def.ledger ?? {}) },
    flags: {},
    clues: [],
    achievements: [],
    endings: [],
    history: [],
  };
}
