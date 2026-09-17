/**
 * 世界书 —— 按关键词触发注入设定，而不是把设定整段塞进上下文。
 *
 * 字段对齐 SillyTavern / CharacterBook V2 的通用约定，这样社区里现成的
 * 世界书与角色卡可以直接导入，不需要重写一遍。
 *
 * 条目形如：
 *   {
 *     id, heading,                   标题（备注用，不进上下文）
 *     keys: [],                      主触发词
 *     secondary: [],                 副触发词
 *     secondaryLogic: 'and-any'      副键逻辑，四选一
 *     content,                       注入正文
 *     constant: false,               🔵 常驻，不看关键词
 *     order: 100,                    插入顺序，小的靠前
 *     probability: 100,              触发概率 0–100
 *     depth: 0,                      0 = 按位置插入；>0 = 插到对话第几层
 *     position: 'at-depth',          before-char / after-char / top-an / bottom-an / at-depth
 *     scanDepth: null,               覆盖全局扫描深度
 *     caseSensitive, matchWholeWords,
 *     recursive: true,               允许它触发的条目再去触发别人
 *     enabled: true,
 *   }
 *
 * 三条纪律：
 *   1. **不进上下文就不该被读到。** 没触发的条目内容不参与渲染。
 *   2. **总额有上限。** 超预算按「常驻优先 → order 大的优先」保住，并如实报告丢了谁。
 *   3. **结果确定。** 除 probability 外一切都是确定的；概率走注入的随机源，测试可控。
 */

export const SECONDARY_LOGIC = Object.freeze(['and-any', 'and-all', 'not-any', 'not-all']);
export const POSITIONS = Object.freeze(['before-char', 'after-char', 'top-an', 'bottom-an', 'at-depth']);

/** 粗略的中文 token 估算：汉字约 1 token/字，英文约 1 token/4 字符 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || !text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase();
}

function isEmptyish(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function asArray(v) {
  if (Array.isArray(v)) return v.filter(x => typeof x === 'string' && x.trim());
  if (typeof v === 'string' && v.trim()) {
    // 社区格式里主键经常是逗号分隔的一整串
    return v.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/** 把任意来源的条目补成标准形状 */
export function normalizeEntry(raw = {}, index = 0) {
  const rawId = raw.id ?? raw.uid;
  const id = !isEmptyish(rawId) ? String(rawId) : `W${index + 1}`;
  const secondary = asArray(raw.secondary ?? raw.keysecondary ?? raw.secondary_keys);

  // 未提供 → 用默认值；提供了但不合法 → 原样留着，交给校验去报错。
  // 静默修正非法值等于把用户的错误藏起来，后面出了怪事根本查不到。
  const logic = raw.secondaryLogic === undefined ? 'and-any' : raw.secondaryLogic;
  const position = raw.position === undefined ? 'at-depth' : raw.position;

  return {
    id,
    heading: isEmptyish(raw.heading ?? raw.comment ?? raw.name) ? null : String(raw.heading ?? raw.comment ?? raw.name),
    // 分类标签（概要 / 主线 / 任务…），供书架分栏展示，不参与触发判定
    category: isEmptyish(raw.category) ? null : String(raw.category),
    keys: asArray(raw.keys ?? raw.key),
    secondary,
    secondaryLogic: logic,
    content: typeof raw.content === 'string' ? raw.content : String(raw.content ?? ''),
    constant: raw.constant === true || raw.strategy === 'constant',
    order: Number.isFinite(raw.order) ? raw.order
      : Number.isFinite(raw.insertion_order) ? raw.insertion_order
        : 100,
    probability: Number.isFinite(raw.probability) ? raw.probability : 100,
    depth: Number.isFinite(raw.depth) ? raw.depth : 0,
    position,
    scanDepth: Number.isFinite(raw.scanDepth) ? raw.scanDepth : null,
    caseSensitive: raw.caseSensitive === true,
    matchWholeWords: raw.matchWholeWords === true,
    recursive: raw.recursive !== false && raw.preventRecursion !== true && raw.excludeRecursion !== true,
    enabled: raw.enabled !== false && raw.disable !== true,
    tokens: Number.isFinite(raw.tokens) ? raw.tokens : null,
  };
}

export function validateEntry(entry, path = 'entry', issues = []) {
  const push = (p, m) => issues.push({ path: p, message: m });
  if (!entry || typeof entry !== 'object') { push(path, '条目必须是对象'); return issues; }

  if (typeof entry.id !== 'string' || !entry.id.trim()) push(`${path}.id`, '条目必须有 id');
  if (typeof entry.content !== 'string' || !entry.content.trim()) push(`${path}.content`, '条目必须有 content');

  if (!entry.constant && (!Array.isArray(entry.keys) || entry.keys.length === 0)) {
    push(`${path}.keys`, '非常驻条目必须给至少一个触发词，否则永远不会被注入');
  }
  if (!SECONDARY_LOGIC.includes(entry.secondaryLogic)) {
    push(`${path}.secondaryLogic`, `副键逻辑必须是 ${SECONDARY_LOGIC.join(' / ')}`);
  }
  if (!POSITIONS.includes(entry.position)) {
    push(`${path}.position`, `插入位置必须是 ${POSITIONS.join(' / ')}`);
  }
  if (!Number.isFinite(entry.order)) push(`${path}.order`, 'order 必须是数字');
  if (!Number.isFinite(entry.probability) || entry.probability < 0 || entry.probability > 100) {
    push(`${path}.probability`, 'probability 必须是 0–100 的数字');
  }
  return issues;
}

export function validateWorldbook(entries) {
  const issues = [];
  if (!Array.isArray(entries)) return { ok: false, issues: [{ path: 'worldbook', message: '必须是数组' }] };

  const seen = new Set();
  entries.forEach((e, i) => {
    validateEntry(e, `worldbook[${i}]`, issues);
    if (e && typeof e.id === 'string') {
      if (seen.has(e.id)) issues.push({ path: `worldbook[${i}].id`, message: `条目 id 重复：${e.id}` });
      seen.add(e.id);
    }
  });
  return { ok: issues.length === 0, issues };
}

/**
 * 改一条世界书条目。
 *
 * 关键在「**展开原条目再覆盖改动字段**」：界面上只给标题 / 关键词 / 内容 /
 * 常驻四项，但条目还有 depth / position / scanDepth / recursive / order 这些
 * 从导入带进来的字段。直接构造新对象等于把它们悄悄抹掉 —— 触发位置和
 * 递归行为会跟着变，而且看不出来。所以先整份复制，再盖改过的键。
 *
 * @param {object[]} entries 原条目数组
 * @param {string} id 要改的条目 id
 * @param {object} patch 只放改动的字段
 * @returns {object[]} 新数组（原数组不动）
 */
export function updateEntry(entries = [], id, patch = {}) {
  return entries.map((e) => {
    if (String(e.id) !== String(id)) return e;
    const base = typeof structuredClone === 'function'
      ? structuredClone(e)
      : JSON.parse(JSON.stringify(e));
    return { ...base, ...patch, id: e.id };   // id 不允许被 patch 改掉
  });
}

/** 删一条世界书条目 */
export function removeEntry(entries = [], id) {
  return entries.filter(e => String(e.id) !== String(id));
}

export function createWorldbook(entries = []) {
  const normalized = entries.map((e, i) => normalizeEntry(e, i));
  const { ok, issues } = validateWorldbook(normalized);
  if (!ok) {
    const err = new Error(`世界书校验失败：\n  - ${issues.map(i => `${i.path} — ${i.message}`).join('\n  - ')}`);
    err.name = 'WorldbookError';
    err.issues = issues;
    throw err;
  }
  return {
    entries: normalized,
    scanDepth: 4,
    tokenBudget: 1024,
    recursiveScanning: true,
  };
}

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */

function hitKeys(hay, keys, { caseSensitive, matchWholeWords } = {}) {
  // caseSensitive 时必须拿原文比，拿小写文本比永远匹配不到
  const target = caseSensitive ? hay.raw : hay.norm;

  return keys.some(rawKey => {
    const key = caseSensitive ? String(rawKey) : normalize(rawKey);
    if (!key) return false;
    if (matchWholeWords) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'u').test(target);
    }
    return target.includes(key);
  });
}

/** 副键的四套逻辑，与酒馆一致 */
function secondaryOk(entry, hay) {
  const sec = entry.secondary;
  if (!sec || sec.length === 0) return true;

  const present = sec.map(k => hay.norm.includes(normalize(k)));
  switch (entry.secondaryLogic) {
    case 'and-any': return present.some(Boolean);
    case 'and-all': return present.every(Boolean);
    case 'not-any': return !present.some(Boolean);
    case 'not-all': return !present.every(Boolean);
    default: return true;
  }
}

function passesProbability(entry, rng) {
  const p = entry.probability;
  if (p >= 100) return true;
  if (p <= 0) return false;
  return rng() * 100 < p;
}

/**
 * 扫描：给定「参与匹配的文本 + 状态」，返回该注入哪些条目。
 *
 * @param {{entries: object[]}} book
 * @param {object} ctx
 * @param {string[]} [ctx.texts]      参与匹配的文本，按时间从旧到新
 * @param {object}   [ctx.state]      状态对象也会被当成匹配源
 * @param {number}   [ctx.budget]     token 上限
 * @param {boolean}  [ctx.recursive]  是否允许递归触发
 * @param {number}   [ctx.scanDepth]  只扫最近几条文本（条目可用自己的 scanDepth 覆盖）
 * @param {Function} [ctx.rng]        概率用的随机源，默认 Math.random
 */
export function scanWorldbook(book, ctx = {}) {
  const {
    texts = [],
    state = null,
    budget = book.tokenBudget ?? Infinity,
    recursive = book.recursiveScanning !== false,
    scanDepth = book.scanDepth ?? null,
    rng = Math.random,
  } = ctx;

  const stateJson = state ? JSON.stringify(state) : '';

  // 每条目可能要求不同的扫描深度，按深度缓存，避免重复拼接
  const hayCache = new Map();
  function hayFor(depth) {
    const cacheKey = depth ?? 'all';
    if (hayCache.has(cacheKey)) return hayCache.get(cacheKey);

    const slice = (depth != null && texts.length > depth) ? texts.slice(-depth) : texts;
    const raw = [...slice, stateJson].join(' ');
    const pair = { raw, norm: normalize(raw) };
    hayCache.set(cacheKey, pair);
    return pair;
  }

  const all = book.entries.filter(e => e.enabled);
  const direct = new Map();     // 直接命中 / 常驻
  const recursed = new Map();   // 被别的条目内容带出来的

  for (const entry of all) {
    const hay = hayFor(entry.scanDepth ?? scanDepth);

    if (entry.constant) { direct.set(entry.id, entry); continue; }
    if (hitKeys(hay, entry.keys, entry) && secondaryOk(entry, hay)) {
      direct.set(entry.id, entry);
    }
  }

  if (recursive) {
    let changed = true;
    let guard = 0;

    while (changed && guard < 20) {
      changed = false;
      guard += 1;

      const seed = [...direct.values(), ...recursed.values()]
        .filter(e => e.recursive)
        .map(e => e.content)
        .join(' ');
      if (!seed.trim()) break;

      const hay = { raw: seed, norm: normalize(seed) };

      for (const entry of all) {
        if (direct.has(entry.id) || recursed.has(entry.id)) continue;
        if (entry.constant) { recursed.set(entry.id, entry); changed = true; continue; }
        if (!hitKeys(hay, entry.keys, entry)) continue;
        if (!secondaryOk(entry, hay)) continue;
        recursed.set(entry.id, entry);
        changed = true;
      }
    }
  }

  // 概率过滤（常驻不参与概率，否则「常驻」就名不副实）
  const candidates = [];
  const skipped = [];
  for (const [id, entry] of direct) {
    if (entry.constant || passesProbability(entry, rng)) candidates.push(entry);
    else skipped.push({ id, reason: 'probability' });
  }
  for (const [id, entry] of recursed) {
    if (passesProbability(entry, rng)) candidates.push(entry);
    else skipped.push({ id, reason: 'probability' });
  }

  // 预算分配：常驻先保，其次 order 大的先保（越靠后插、影响越大）
  const orderIndex = new Map(book.entries.map((e, i) => [e.id, i]));
  const byBudgetPriority = [...candidates].sort((a, b) => {
    if (a.constant !== b.constant) return a.constant ? -1 : 1;
    if (b.order !== a.order) return b.order - a.order;
    return (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0);
  });

  const kept = new Set();
  const dropped = [];
  let used = 0;

  for (const entry of byBudgetPriority) {
    const cost = entry.tokens ?? estimateTokens(entry.content);
    if (used + cost > budget) {
      dropped.push({ id: entry.id, tokens: cost, reason: '超出预算' });
      continue;
    }
    used += cost;
    kept.add(entry.id);
  }

  // 输出按插入顺序：order 小的靠前
  const ordered = candidates
    .filter(e => kept.has(e.id))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0);
    });

  return {
    entries: ordered,
    tokens: used,
    dropped,
    skipped,
    direct: ordered.filter(e => direct.has(e.id)).map(e => e.id),
    recursed: ordered.filter(e => recursed.has(e.id)).map(e => e.id),
  };
}

/** 把选中的条目拼成一段可注入的文本 */
export function renderWorldbook(entries, applyMacros = null) {
  if (!entries || entries.length === 0) return '';
  return entries
    .map(e => {
      const body = applyMacros ? applyMacros(e.content) : e.content;
      return e.heading ? `【${e.heading}】\n${body}` : body;
    })
    .join('\n\n');
}
