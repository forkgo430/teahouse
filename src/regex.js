/**
 * 正则后处理 —— 酒馆 Regex 扩展的对位实现。
 *
 * ## 数据模型：source × destination 二维（读源码后确定，不是社区讲的"四作用点"）
 *
 * 酒馆（SillyTavern）正则的真实模型是两个**正交**维度，各自可多选。
 * 见 `JS-Slash-Runner/src/function/tavern_regex.ts` 的 `TavernRegex` 类型：
 *
 *   source       这段文本从哪来      destination   结果送去哪
 *     user_input   玩家输入            display   只改渲染（不进上下文）
 *     ai_output    模型输出            prompt    进提示词（模型会读到）
 *     slash_command / world_info / reasoning
 *
 * 社区教程普遍讲成"四个作用点选一"（editinput / editoutput / editprocess /
 * editdisplay）—— 那是把二维讲成了一维。一条规则可以同时挂 display 与 prompt，
 * 也可以只挂其一。
 *
 * **前端卡 token 安全的根本**就是：只开 display、不开 prompt。
 *
 * 本实现取其中与茶馆相关的两个 source（玩家输入 / 模型输出）与两个
 * destination（显示 / 提示词），够用且不引入无对应的概念。
 *
 * 规则形如：
 *   {
 *     id, name,
 *     find: 'pattern',        正则源（构造失败会被标记 invalid 并停用）
 *     flags: 'g',             默认 'g'
 *     replace: '',            替换文本（支持 $1 捕获组）
 *     source: { input: bool, output: bool },       这条规则作用于哪段文本
 *     destination: { display: bool, prompt: bool }, 改完送去哪
 *     enabled: true,
 *   }
 *
 * 三条纪律：
 *   1. **非法正则跳过并报告**，不静默吞 —— 一个坏规则不该拖死整条链。
 *   2. **只开 display 的规则不进上下文** —— 这是 token 安全的保证。
 *   3. **老数据读时映射，不丢** —— `scope: 'out'` 一类旧字段按语义折算。
 */

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

/**
 * 旧格式（`scope: 'in'|'out'|'both'`）折算成 source + destination。
 *
 * 为什么这样折：
 *   - `out`（模型输出）原本就是"改模型正文"，语义上同时影响存储与显示
 *     → display + prompt 都开，功能不缩水
 *   - `in`（玩家输入）改的是玩家那句话，玩家本来就能看到自己的输入
 *     → display + prompt 都开，同理
 *   - 任何旧规则都是**两个目标都开**，因为它们当初就是这么干的
 *     （工程上不存在"只显示不提示"的旧规则）
 *
 * 这是**读时映射**而不是硬迁移：不改用户 localStorage 里的原始数据，
 * 只在使用时折算。若将来要落盘成新格式，这里就是唯一的换算点。
 */
function fromLegacyScope(scope) {
  const s = ['in', 'out', 'both'].includes(scope) ? scope : 'out';
  return {
    source: { input: s === 'in' || s === 'both', output: s === 'out' || s === 'both' },
    destination: { display: true, prompt: true },
  };
}

/** 把任意来源的规则补成标准形状 */
export function normalizeRule(raw = {}, index = 0) {
  const legacy = raw.source === undefined || raw.destination === undefined;
  const folded = legacy ? fromLegacyScope(raw.scope) : null;

  const src = raw.source ?? folded.source;
  const dst = raw.destination ?? folded.destination;

  return {
    id: raw.id ?? `RX${index + 1}`,
    name: raw.name ?? `规则 ${index + 1}`,
    find: typeof raw.find === 'string' ? raw.find : String(raw.find ?? ''),
    flags: typeof raw.flags === 'string' && raw.flags ? raw.flags : 'g',
    replace: typeof raw.replace === 'string' ? raw.replace : '',

    source: {
      input: src?.input === true,
      output: src?.output === true,
    },
    destination: {
      display: dst?.display === true,
      prompt: dst?.prompt === true,
    },

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

/* ------------------------------------------------------------------ *
 * 应用
 * ------------------------------------------------------------------ */

/**
 * 判定规则在给定 (source, destination) 组合下是否生效。
 *
 * @param {object} rule
 * @param {'input'|'output'} source 作用于哪段文本
 * @param {'display'|'prompt'} destination 结果送去哪
 */
function ruleApplies(rule, source, destination) {
  if (!rule.enabled || rule.invalid || !rule.find) return false;
  return rule.source?.[source] === true && rule.destination?.[destination] === true;
}

/**
 * 对文本按顺序应用一串规则。
 *
 * @param {string} text
 * @param {object[]} rules
 * @param {'input'|'output'} source
 * @param {'display'|'prompt'} destination
 * @returns {{ text: string, applied: string[] }}
 */
export function applyRules(text, rules, source, destination) {
  let out = String(text ?? '');
  const applied = [];
  for (const rule of rules) {
    if (!ruleApplies(rule, source, destination)) continue;
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

/* ---- 四个组合的便捷出口 ---- */

/** 模型输出 → 进提示词（模型能读到改动） */
export function applyOutbound(text, rules) {
  return applyRules(text, rules, 'output', 'prompt');
}

/** 玩家输入 → 进提示词 */
export function applyInbound(text, rules) {
  return applyRules(text, rules, 'input', 'prompt');
}

/**
 * 只改渲染、**不进上下文** —— 前端卡 token 安全的出口。
 *
 * 调用方必须在「准备显示给玩家」时用它，绝不能在「送进提示词」时用它。
 * 反过来也一样：`applyOutbound` 的结果会进模型，别把 HTML 交给它。
 */
export function applyDisplayOutbound(text, rules) {
  return applyRules(text, rules, 'output', 'display');
}

/** 玩家输入在显示层的变换（如把 `*动作*` 渲染成斜体） */
export function applyDisplayInbound(text, rules) {
  return applyRules(text, rules, 'input', 'display');
}

/* ------------------------------------------------------------------ *
 * 出厂规则（新装开局就有的几条）
 * ------------------------------------------------------------------ */

/**
 * 新装的账号 localStorage 里是空的，正则面板会是一片空白 ——
 * 玩家只看到一个「添加规则」按钮，不知道规则长什么样、能干什么。
 *
 * 这几条是**能立刻看出效果的**最小集合，各自演示一个维度：
 *   - 两条 display-only：只改渲染、不进上下文 → 演示 token 安全
 *   - 一条 prompt：真的改写送进模型的文本 → 演示"模型能读到"
 *
 * 都是 `enabled: true`，但**不会误伤**：只会匹配各自明确的标记语法，
 * 不带标记的正文原样穿过。
 *
 * 注意：这是**首次安装的种子数据**，不是运行时补写。玩家删掉之后
 * 不会再被塞回来 —— 面板里 null 与 [] 的区别就在这里。
 */
export const SHIPPED_RULES = [
  {
    id: 'rx-shipped-stat',
    name: '状态栏（前端卡）',
    // 把 AI 偶尔写歪的 `[状态栏]` 变体收敛成引擎认得的规范写法
    find: '［(状态栏|物品栏|背包|属性|在场)］',
    replace: '[$1]',
    flags: 'g',
    source: { input: false, output: true },
    destination: { display: true, prompt: false },
    enabled: true,
  },
  {
    id: 'rx-shipped-em',
    name: '心声 · 斜体',
    // `*心声*` → 斜体。只改显示，模型读到的仍是原文
    find: '\\*([^*\\n]{1,40})\\*',
    replace: '<em>$1</em>',
    flags: 'g',
    source: { input: false, output: true },
    destination: { display: true, prompt: false },
    enabled: true,
  },
  {
    id: 'rx-shipped-trim',
    name: '收尾空白',
    // 进提示词的那一条：清掉行尾空格，省 token 也让模型少学坏格式
    find: '[ \\t]+$',
    replace: '',
    flags: 'gm',
    source: { input: true, output: true },
    destination: { display: false, prompt: true },
    enabled: true,
  },
];
