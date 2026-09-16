/**
 * 条件判定器 —— 引擎里唯一允许做「判断」的地方。
 *
 * 设计要点：
 *   1. 条件表达式是**纯数据**（对象），不是可执行代码。这样才能被校验、
 *      被序列化进存档、将来也能安全地由外部来源（模型）生成。
 *   2. 判定必须**可预测**。核心规则见下方 MISSING_PATH_RULE。
 *   3. 不抛异常。条件不成立就是 false —— 缺字段、类型不符都走 false 分支，
 *      由调用方通过 explain() 查看原因。
 *
 * 条件表达式（递归）：
 *   null                                  恒真
 *   { all: [c, ...] }                     全部成立
 *   { any: [c, ...] }                     任一成立
 *   { not: c }                            取反
 *   { path, op, value }                   原子比较
 *
 * 原子运算符：
 *   ==  !=        严格相等（不做隐式类型转换）
 *   >   >=  <  <= 仅当两侧都是有限数字时成立
 *   contains      path 取到的是数组，value 是其中元素
 *   in            value 是数组，path 取到的值在其中
 *   exists        path 取到的值存在且不为 null / undefined（不需要 value）
 */

/**
 * 缺失路径规则（MISSING_PATH_RULE）
 * ------------------------------------------------------------------
 * 除 exists 外，任何运算符在 path 不存在时一律返回 false。
 * 不抛错、不做隐式转换、不把 undefined 当作特殊值参与比较。
 *
 * 需要表达「字段未设置」时，请显式写成逻辑组合，例如：
 *   { not: { path: 'flags.seen', op: '==', value: true } }
 */
export const MISSING_PATH_RULE = 'missing-path-yields-false';

const KEY_RE = /^([^[\]]*)((?:\[\d+\])*)$/;

/** 把 'stats.lin.trust' / 'clues[0].tag' 拆成段 */
export function splitPath(path) {
  if (typeof path !== 'string' || path.trim() === '') return null;
  const segs = [];
  for (const raw of path.split('.')) {
    const m = KEY_RE.exec(raw);
    if (!m) return null;
    if (m[1]) segs.push({ key: m[1] });
    if (m[2]) {
      for (const hit of m[2].matchAll(/\[(\d+)\]/g)) {
        segs.push({ index: Number(hit[1]) });
      }
    }
  }
  return segs.length > 0 ? segs : null;
}

/**
 * 按路径取值
 * @returns {{ found: boolean, value: unknown }}
 */
export function resolvePath(root, path) {
  const segs = splitPath(path);
  if (!segs) return { found: false, value: undefined };

  let cur = root;
  for (const seg of segs) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };

    if ('key' in seg) {
      if (typeof cur !== 'object') return { found: false, value: undefined };
      if (!Object.prototype.hasOwnProperty.call(cur, seg.key)) return { found: false, value: undefined };
      cur = cur[seg.key];
    } else {
      if (typeof cur !== 'object') return { found: false, value: undefined };
      if (!(seg.index in cur)) return { found: false, value: undefined };
      cur = cur[seg.index];
    }
  }
  return { found: true, value: cur };
}

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 原子条件求值
 * @returns {boolean}
 */
export function evaluateAtom(cond, ctx) {
  const { found, value } = resolvePath(ctx, cond.path);
  const op = cond.op;

  if (op === 'exists') {
    return found && value !== undefined && value !== null;
  }

  if (!found) return false;

  switch (op) {
    case '==':
      return value === cond.value;
    case '!=':
      return value !== cond.value;
    case '>':
      return isNumber(value) && isNumber(cond.value) && value > cond.value;
    case '>=':
      return isNumber(value) && isNumber(cond.value) && value >= cond.value;
    case '<':
      return isNumber(value) && isNumber(cond.value) && value < cond.value;
    case '<=':
      return isNumber(value) && isNumber(cond.value) && value <= cond.value;
    case 'contains':
      return Array.isArray(value) && value.includes(cond.value);
    case 'in':
      return Array.isArray(cond.value) && cond.value.includes(value);
    default:
      return false;
  }
}

/**
 * 条件求值（主入口）
 * @param {object|null} cond
 * @param {object} ctx 通常直接传状态对象
 * @returns {boolean}
 */
export function evaluate(cond, ctx) {
  if (cond === null || cond === undefined) return true;

  if ('all' in cond) return cond.all.every(c => evaluate(c, ctx));
  if ('any' in cond) return cond.any.some(c => evaluate(c, ctx));
  if ('not' in cond) return !evaluate(cond.not, ctx);

  return evaluateAtom(cond, ctx);
}

/**
 * 带轨迹求值 —— 用来回答「这个分支为什么没命中」。
 * 不做短路，所有原子条件都会留下记录。
 *
 * @returns {{ result: boolean, steps: Array<{path: string, op: string, expected?: unknown, actual?: unknown, found: boolean, ok: boolean, note: string}> }}
 */
export function explain(cond, ctx, state = { steps: [] }) {
  const steps = state.steps;

  if (cond === null || cond === undefined) {
    steps.push({ path: '(null)', op: 'null', found: true, ok: true, note: '恒真' });
    return { result: true, steps };
  }

  if ('all' in cond) {
    // 不短路：先全部求值，再汇总
    const results = cond.all.map(c => explain(c, ctx, state).result);
    const result = results.every(Boolean);
    steps.push({ path: '(all)', op: 'all', found: true, ok: result, note: `${results.filter(Boolean).length}/${results.length} 成立` });
    return { result, steps };
  }

  if ('any' in cond) {
    const results = cond.any.map(c => explain(c, ctx, state).result);
    const result = results.some(Boolean);
    steps.push({ path: '(any)', op: 'any', found: true, ok: result, note: `${results.filter(Boolean).length}/${results.length} 成立` });
    return { result, steps };
  }

  if ('not' in cond) {
    const inner = explain(cond.not, ctx, state).result;
    const result = !inner;
    steps.push({ path: '(not)', op: 'not', found: true, ok: result, note: `内层为 ${inner}` });
    return { result, steps };
  }

  const { found, value } = resolvePath(ctx, cond.path);
  const ok = evaluateAtom(cond, ctx);

  let note;
  if (cond.op === 'exists') {
    note = found ? `→ ${describe(value)}` : '路径不存在';
  } else if (!found) {
    note = `路径不存在（按 MISSING_PATH_RULE 记为 false）`;
  } else {
    note = `${describe(value)} ${ok ? '满足' : '不满足'} ${cond.op} ${describe(cond.value)}`;
  }

  steps.push({ path: cond.path, op: cond.op, expected: cond.value, actual: found ? value : undefined, found, ok, note });
  return { result: ok, steps };
}

function describe(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(describe).join(', ')}]`;
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 批量求值，返回命中的下标 */
export function matchingIndexes(conds, ctx) {
  const out = [];
  conds.forEach((c, i) => { if (evaluate(c, ctx)) out.push(i); });
  return out;
}

/** 仅用于调试输出：把 explain 的轨迹格式化成短文本 */
export function formatTrace(trace) {
  return trace.steps.map(s => `  [${s.ok ? '√' : '×'}] ${s.path} ${s.note}`).join('\n');
}
