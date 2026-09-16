/**
 * 变量宏 —— 让设定与文本里可以写 {{占位}}，运行时替换。
 *
 * 支持两种：
 *   内置量   {{day}} {{slot}} {{where}} {{clues}} {{actors}} {{user}} {{char}}
 *   自定义量 {{getvar::名}} {{setvar::名::值}}
 *
 * 纪律：**认不出来的宏原样保留**，不要替换成空。
 * 静默吃掉一个拼错的宏，比在界面上看见 {{dya}} 危险得多。
 */

const TOKEN_RE = /\{\{([^{}]+)\}\}/g;

/** 从状态里生成内置量 */
export function buildBuiltins(state, world = null, extra = {}) {
  const slot = world?.slotLabels?.[state?.clock?.slot] ?? state?.clock?.slot ?? '';
  const where = world?.placeLabels?.[state?.where] ?? state?.where ?? '';

  const clues = (state?.clues ?? [])
    .map(id => world?.clueLabels?.[id] ?? id)
    .join('、');

  const actors = Object.values(state?.actors ?? {})
    .filter(a => a.met)
    .map(a => world?.actorLabels?.[a.id] ?? a.name ?? a.id)
    .join('、');

  return {
    day: String(state?.clock?.day ?? ''),
    slot,
    where,
    clues,
    actors,
    ...extra,
  };
}

/**
 * 应用宏。
 * @param {string} text
 * @param {{ vars?: object, builtins?: object }} ctx vars 会被 setvar 就地修改
 */
export function applyMacros(text, ctx = {}) {
  const vars = ctx.vars ?? {};
  const builtins = ctx.builtins ?? {};

  const lookup = (name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]);
    if (Object.prototype.hasOwnProperty.call(builtins, name)) return String(builtins[name]);
    return null;   // 未知 → 保留原样
  };

  return String(text ?? '').replace(TOKEN_RE, (whole, rawExpr) => {
    const expr = String(rawExpr).trim();
    if (!expr) return whole;

    const parts = expr.split('::').map(s => s.trim());
    const head = parts[0].toLowerCase();

    if (head === 'getvar') {
      const value = lookup(parts[1] ?? '');
      return value === null ? whole : value;
    }

    if (head === 'setvar') {
      const name = parts[1];
      if (!name) return whole;
      vars[name] = parts.slice(2).join('::');
      return '';
    }

    const value = lookup(expr);
    return value === null ? whole : value;
  });
}

/** 找出文本里所有认不出来的宏，用于报告而不是无声吞掉 */
export function findUnknownMacros(text, ctx = {}) {
  const vars = ctx.vars ?? {};
  const builtins = ctx.builtins ?? {};
  const unknown = new Set();

  for (const hit of String(text ?? '').matchAll(TOKEN_RE)) {
    const expr = String(hit[1]).trim();
    const parts = expr.split('::').map(s => s.trim());
    const head = parts[0].toLowerCase();
    if (head === 'setvar') continue;

    const name = head === 'getvar' ? parts[1] : expr;
    if (!name) { unknown.add(expr); continue; }
    if (!Object.prototype.hasOwnProperty.call(vars, name)
      && !Object.prototype.hasOwnProperty.call(builtins, name)) {
      unknown.add(name);
    }
  }
  return [...unknown];
}

/** 批量替换：把一组文本里的宏统一替换掉（共用同一份 vars，setvar 才有效果） */
export function applyMacrosToList(texts, ctx = {}) {
  return texts.map(t => applyMacros(t, ctx));
}
