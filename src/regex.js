/**
 * 正则后处理 —— 酒馆 Regex 扩展的轻量版。
 *
 * 规则形如：
 *   {
 *     id, name,
 *     find: 'pattern',        正则源（new RegExp 构造，非法会被跳过并报告）
 *     flags: 'g',             默认 'g'
 *     replace: '',            替换文本（支持 $1 捕获组）
 *     scope: 'out',           'out' = 模型输出；'in' = 玩家输入；'both'
 *     enabled: true,
 *   }
 *
 * 纪律：非法正则**跳过并报告**，不静默吞 —— 一个坏规则不该拖死整条链。
 */

export function normalizeRule(raw = {}, index = 0) {
  return {
    id: raw.id ?? `RX${index + 1}`,
    name: raw.name ?? `规则 ${index + 1}`,
    find: typeof raw.find === 'string' ? raw.find : String(raw.find ?? ''),
    flags: typeof raw.flags === 'string' && raw.flags ? raw.flags : 'g',
    replace: typeof raw.replace === 'string' ? raw.replace : '',
    scope: ['out', 'in', 'both'].includes(raw.scope) ? raw.scope : 'out',
    enabled: raw.enabled !== false,
    /** 非法的正则在 normalize 时就标记出来，应用时跳过 */
    invalid: false,
  };
}

/** 把一组原始规则变成可用规则链（非法的标记 invalid 并回传） */
export function createRegexChain(rawRules = []) {
  const rules = [];
  const issues = [];

  rawRules.forEach((raw, i) => {
    const rule = normalizeRule(raw, i);
    try {
      new RegExp(rule.find, rule.flags);   // 试编译
      rules.push(rule);
    } catch (e) {
      rule.invalid = true;
      rule.enabled = false;
      rules.push(rule);
      issues.push({ id: rule.id, message: `非法正则已停用：${e.message}` });
    }
  });

  return { rules, issues };
}

function ruleApplies(rule, scope) {
  if (!rule.enabled || rule.invalid || !rule.find) return false;
  return rule.scope === 'both' || rule.scope === scope;
}

/** 对文本按顺序应用一串规则 */
export function applyRules(text, rules, scope) {
  let out = String(text ?? '');
  const applied = [];
  for (const rule of rules) {
    if (!ruleApplies(rule, scope)) continue;
    try {
      const re = new RegExp(rule.find, rule.flags.includes('g') ? rule.flags : `${rule.flags}g`);
      const before = out;
      out = out.replace(re, rule.replace);
      if (out !== before) applied.push(rule.id);
    } catch {
      /* 运行时替换出错也跳过，不中断链 */
    }
  }
  return { text: out, applied };
}

/** 模型输出后处理（scope 'out' 的规则） */
export function applyOutbound(text, rules) {
  return applyRules(text, rules, 'out');
}

/** 玩家输入预处理（scope 'in' 的规则） */
export function applyInbound(text, rules) {
  return applyRules(text, rules, 'in');
}
