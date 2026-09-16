/**
 * 外部资产适配器 —— 直接吃社区现成的世界书与角色卡。
 *
 * 支持三种输入：
 *   1. SillyTavern 世界书 JSON（entries 是对象，字段 key / keysecondary / order / disable…）
 *   2. Character Card V2 内嵌的 character_book（entries 是数组，字段 keys / secondary_keys / insertion_order…）
 *   3. 角色卡 V1 / V2 JSON，以及嵌了角色卡的 PNG（tEXt 块里的 chara 字段）
 *
 * 原则：**能读就读，读不动的部分如实报告，不猜、不丢。**
 * 认不出的字段原样留在 meta.extensions 里，绝不静默丢弃 —— 用户的东西不能在我这儿蒸发。
 */

import { normalizeEntry } from './worldbook.js';

export const KIND = Object.freeze({
  WORLDBOOK: 'worldbook',
  CHARACTER: 'character',
  PRESET: 'preset',
  UNKNOWN: 'unknown',
});

/** 角色卡本身不带数值系统，导入时给一组可改的默认值 */
export const DEFAULT_STATS = Object.freeze([
  { key: 'trust', label: '信任', min: 0, max: 100, init: 30 },
  { key: 'mood', label: '情绪', min: 0, max: 100, init: 50 },
  { key: 'guard', label: '戒备', min: 0, max: 100, init: 40 },
]);

/* ------------------------------------------------------------------ *
 * 识别
 * ------------------------------------------------------------------ */

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function detectKind(raw) {
  if (!isPlainObject(raw)) return KIND.UNKNOWN;

  // 预设：酒馆的 preset 带 prompts 数组 + 采样参数
  if (Array.isArray(raw.prompts) && (raw.temperature !== undefined || raw.openai_max_tokens !== undefined)) {
    return KIND.PRESET;
  }

  // entries 是世界书的强特征，先判它 —— 否则带 name/description 的
  // 世界书会被角色卡的启发式规则抢走。
  if (raw.entries !== undefined) return KIND.WORLDBOOK;

  if (raw.spec === 'chara_card_v2' || isPlainObject(raw.data)) return KIND.CHARACTER;
  // V1 没有 spec，靠 name + 开场白/描述判断
  if (raw.name !== undefined && (raw.first_mes !== undefined || raw.description !== undefined)) {
    return KIND.CHARACTER;
  }

  // 次级预设判定：放在角色卡之后 —— V1 卡也可能带 system_prompt，
  // 所以只有「不像卡」的才落到这里。只带 system_prompt 的预设很常见。
  if (Array.isArray(raw.prompts) || typeof raw.system_prompt === 'string') {
    return KIND.PRESET;
  }
  return KIND.UNKNOWN;
}

/* ------------------------------------------------------------------ *
 * 预设（采样参数 + 系统提示词）
 * ------------------------------------------------------------------ */

/**
 * 预设 → 采样参数 + 系统提示词。
 * 酒馆的 openai preset 里 prompts 是完整提示词栈，这里只取
 * 「启用的 system 段」拼成系统提示词；采样参数做字段名宽容映射。
 */
export function importPreset(raw) {
  const warnings = [];

  if (!isPlainObject(raw)) {
    return { kind: KIND.PRESET, name: null, settings: {}, systemPrompt: '', warnings: ['输入不是对象'] };
  }

  const num = (...xs) => {
    for (const x of xs) if (Number.isFinite(x)) return x;
    return undefined;
  };

  const settings = {};
  const temp = num(raw.temperature, raw.temp);
  if (temp !== undefined) settings.temperature = temp;
  const topP = num(raw.top_p, raw.topP);
  if (topP !== undefined) settings.topP = topP;
  const maxTokens = num(raw.openai_max_tokens, raw.max_tokens, raw.maxTokens, raw.max_length);
  if (maxTokens !== undefined) settings.maxTokens = maxTokens;
  const freqPen = num(raw.frequency_penalty);
  if (freqPen !== undefined) settings.frequencyPenalty = freqPen;
  const presPen = num(raw.presence_penalty);
  if (presPen !== undefined) settings.presencePenalty = presPen;

  let systemPrompt = '';
  if (Array.isArray(raw.prompts)) {
    const parts = raw.prompts
      .filter(p => isPlainObject(p) && p.enabled !== false && (p.role ?? 'system') === 'system' && typeof p.content === 'string')
      .map(p => p.content.trim())
      .filter(Boolean);
    systemPrompt = parts.join('\n\n');
    const skipped = raw.prompts.length - parts.length;
    if (skipped > 0) warnings.push(`提示词栈里 ${skipped} 段未启用或非 system，已跳过`);
  } else if (typeof raw.system_prompt === 'string') {
    systemPrompt = raw.system_prompt;
  }

  if (Object.keys(settings).length === 0 && !systemPrompt) {
    warnings.push('这份预设里既没有采样参数也没有可用的系统提示词');
  }

  return {
    kind: KIND.PRESET,
    name: raw.name ?? null,
    settings,
    systemPrompt,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * 世界书
 * ------------------------------------------------------------------ */

function pickNumber(...candidates) {
  for (const c of candidates) {
    if (Number.isFinite(c)) return c;
  }
  return undefined;
}

/** SillyTavern 用数字表示插入位置，CharacterBook 用字符串 */
function mapPosition(v) {
  if (typeof v === 'number') {
    return ['before-char', 'after-char', 'top-an', 'bottom-an', 'at-depth'][v] ?? 'at-depth';
  }
  if (typeof v === 'string') {
    const s = v.replace(/_/g, '-').toLowerCase();
    if (s === 'before-char' || s === 'beforechar') return 'before-char';
    if (s === 'after-char' || s === 'afterchar') return 'after-char';
    if (s === 'top-an') return 'top-an';
    if (s === 'bottom-an') return 'bottom-an';
    return 'at-depth';
  }
  return 'at-depth';
}

/**
 * 世界书 → 内部条目。
 * @param {object} raw SillyTavern 世界书，或 CharacterBook，或 {entries: any[]}
 */
export function importWorldbook(raw) {
  const warnings = [];

  if (!isPlainObject(raw)) {
    return { kind: KIND.WORLDBOOK, entries: [], meta: {}, warnings: ['输入不是对象，无法作为世界书读取'] };
  }

  const container = raw.entries ?? raw;

  let list;
  if (Array.isArray(container)) {
    list = container.map((e, i) => ({ ...e, __fallbackId: `W${i + 1}` }));
  } else if (isPlainObject(container)) {
    // SillyTavern 的 entries 是 { "0": {...}, "1": {...} }，键就是 uid
    list = Object.entries(container).map(([key, value]) => (
      isPlainObject(value) ? { ...value, __fallbackId: key } : null
    )).filter(Boolean);
  } else {
    return { kind: KIND.WORLDBOOK, entries: [], meta: {}, warnings: ['entries 既不是数组也不是对象'] };
  }

  const entries = list.map((e, i) => {
    const raw2 = {
      id: e.uid ?? e.id ?? e.__fallbackId ?? `W${i + 1}`,
      heading: e.comment ?? e.name ?? null,
      keys: e.key ?? e.keys,
      secondary: e.keysecondary ?? e.secondary_keys ?? e.keysecondary_keys,
      secondaryLogic: e.secondaryLogic ?? (e.keysecondary || e.secondary_keys ? 'and-any' : undefined),
      content: e.content,
      constant: e.constant === true || e.strategy === 'constant',
      order: pickNumber(e.order, e.insertion_order),
      probability: e.useProbability === false ? 100 : pickNumber(e.probability),
      depth: pickNumber(e.depth),
      position: mapPosition(e.position),
      scanDepth: pickNumber(e.scanDepth),
      caseSensitive: typeof e.caseSensitive === 'boolean' ? e.caseSensitive : undefined,
      matchWholeWords: typeof e.matchWholeWords === 'boolean' ? e.matchWholeWords : undefined,
      recursive: e.excludeRecursion === true || e.preventRecursion === true ? false : undefined,
      enabled: e.disable === true ? false : (typeof e.enabled === 'boolean' ? e.enabled : undefined),
    };
    return normalizeEntry(raw2, i);
  });

  const empty = entries.filter(e => !e.content.trim());
  if (empty.length > 0) warnings.push(`${empty.length} 个条目没有正文，已跳过：${empty.map(e => e.id).join(', ')}`);

  const usable = entries.filter(e => e.content.trim());

  // 认不出的顶层字段原样留着，别丢
  const meta = {
    name: raw.name ?? null,
    description: raw.description ?? null,
    scanDepth: pickNumber(raw.scan_depth, raw.scanDepth),
    tokenBudget: pickNumber(raw.token_budget, raw.tokenBudget),
    recursiveScanning: raw.recursive_scanning ?? raw.recursiveScanning ?? null,
    extensions: isPlainObject(raw.extensions) ? raw.extensions : {},
  };

  return { kind: KIND.WORLDBOOK, entries: usable, meta, warnings };
}

/** 内置：CharacterBook（角色卡里的世界书）就是世界书格式的一种 */
export function importCharacterBook(book) {
  return importWorldbook(book);
}

/* ------------------------------------------------------------------ *
 * 角色卡
 * ------------------------------------------------------------------ */

function slugify(name) {
  const base = String(name ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'char';
}

/**
 * 角色卡 → 内部角色定义 + 世界书 + 开场白。
 * V1 与 V2 都吃；V2 的内嵌世界书会自动带出来。
 */
export function importCharacterCard(raw) {
  const warnings = [];

  if (!isPlainObject(raw)) {
    return { kind: KIND.CHARACTER, actor: null, book: [], greetings: [], warnings: ['输入不是对象'] };
  }

  const isV2 = raw.spec === 'chara_card_v2' || isPlainObject(raw.data);
  const data = isV2 ? raw.data : raw;

  if (!isPlainObject(data)) {
    return { kind: KIND.CHARACTER, actor: null, book: [], greetings: [], warnings: ['卡片里找不到 data'] };
  }

  if (!data.name) warnings.push('角色卡没有 name 字段，已用「未命名」占位');

  const actor = {
    id: slugify(data.name),
    name: data.name || '未命名',
    // 角色卡不带数值系统，这里给一组通用初值，导入后可自行调整
    stats: DEFAULT_STATS.map(s => ({ ...s })),
    adult: true,
  };
  warnings.push('角色卡不含数值系统，已套用默认三项（信任 / 情绪 / 戒备），可在数据里改');

  let book = [];
  if (data.character_book) {
    const imported = importCharacterBook(data.character_book);
    book = imported.entries;
    warnings.push(...imported.warnings);
  }

  const greetings = [
    data.first_mes,
    ...(Array.isArray(data.alternate_greetings) ? data.alternate_greetings : []),
  ].filter(s => typeof s === 'string' && s.trim());

  const known = new Set([
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings',
    'character_book', 'tags', 'creator', 'character_version', 'extensions',
  ]);
  const extra = Object.fromEntries(Object.entries(data).filter(([k]) => !known.has(k)));
  if (Object.keys(extra).length > 0) {
    warnings.push(`有 ${Object.keys(extra).length} 个未识别的字段，已原样保存在 meta.extra 里：${Object.keys(extra).join(', ')}`);
  }

  return {
    kind: KIND.CHARACTER,
    spec: isV2 ? 'v2' : 'v1',
    actor,
    book,
    greetings,
    persona: {
      description: data.description ?? '',
      personality: data.personality ?? '',
      scenario: data.scenario ?? '',
      example: data.mes_example ?? '',
    },
    systemPrompt: data.system_prompt ?? '',
    postHistory: data.post_history_instructions ?? '',
    meta: {
      spec: isV2 ? 'v2' : 'v1',
      creator: data.creator ?? null,
      version: data.character_version ?? null,
      tags: Array.isArray(data.tags) ? data.tags : [],
      notes: data.creator_notes ?? '',
      extensions: isPlainObject(data.extensions) ? data.extensions : {},
      extra,
    },
    warnings,
  };
}

/** 自动识别后导入 */
export function importAny(raw) {
  const kind = detectKind(raw);
  if (kind === KIND.CHARACTER) return importCharacterCard(raw);
  if (kind === KIND.WORLDBOOK) return importWorldbook(raw);
  // 预设也必须走这里 —— 否则「模式（预设）」分区永远导不进来
  if (kind === KIND.PRESET) return importPreset(raw);
  return { kind: KIND.UNKNOWN, warnings: ['认不出这是什么格式：既不像世界书，也不像角色卡，也不像预设'] };
}

/**
 * 按指定分类导入。分类不符时返回 unknown + 说明，**不静默改导成别的东西**。
 * UI 的分区语义靠它落实：三个分区不是三个外壳，是三条不同的解析入口。
 * @param {object} raw 原始 JSON
 * @param {'worldbook'|'character'|'preset'} expect 期望分类
 * @param {string} [expectLabel] 该分类的中文名，用于提示文案
 */
export function importAs(raw, expect, expectLabel) {
  const actual = detectKind(raw);
  const label = { worldbook: '世界书', character: '角色卡', preset: '预设', unknown: '未知内容' };
  if (actual !== expect) {
    const got = label[actual] ?? actual;
    return {
      kind: KIND.UNKNOWN,
      warnings: [
        actual === KIND.UNKNOWN
          ? `这不是可识别的数据：既不像${label[expect] ?? expect}，也不像其他已知格式`
          : `当前分类是「${expectLabel ?? label[expect]}」，但这份内容是「${got}」—— 切到对应分类再导入`,
      ],
    };
  }
  return importAny(raw);
}

/* ------------------------------------------------------------------ *
 * PNG 角色卡
 * ------------------------------------------------------------------ */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function latin1(bytes) {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function indexOfZero(bytes, from = 0) {
  for (let i = from; i < bytes.length; i++) {
    if (bytes[i] === 0) return i;
  }
  return -1;
}

/** base64 → UTF-8 字符串（角色卡内容常用这种方式塞进 PNG） */
export function decodeBase64Utf8(b64) {
  const clean = String(b64 ?? '').replace(/\s+/g, '');
  if (!clean) throw new Error('base64 内容为空');

  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function parseTextChunk(chunk, type) {
  const nul = indexOfZero(chunk);
  if (nul < 0) return null;

  const keyword = latin1(chunk.subarray(0, nul));

  if (type === 'tEXt') {
    return { keyword, text: latin1(chunk.subarray(nul + 1)) };
  }

  // iTXt: keyword \0 compressionFlag compressionMethod langTag \0 translatedKeyword \0 text
  const compressionFlag = chunk[nul + 1];
  let p = nul + 3;
  const langEnd = indexOfZero(chunk, p);
  if (langEnd < 0) return null;
  p = langEnd + 1;
  const transEnd = indexOfZero(chunk, p);
  if (transEnd < 0) return null;
  p = transEnd + 1;

  if (compressionFlag === 1) {
    return { keyword, text: null, compressed: true };
  }
  return { keyword, text: new TextDecoder().decode(chunk.subarray(p)) };
}

/**
 * 从 PNG 字节里取出角色卡 JSON。
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {object} 角色卡对象（V1 或 V2）
 */
export function readPngCard(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (u8.length < 8) throw new Error('文件太小，不是有效的 PNG');
  for (let i = 0; i < 8; i++) {
    if (u8[i] !== PNG_SIG[i]) throw new Error('这不是 PNG 文件');
  }

  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let offset = 8;
  let sawCompressed = false;

  while (offset + 8 <= u8.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd > u8.length) break;

    if (type === 'tEXt' || type === 'iTXt') {
      const parsed = parseTextChunk(u8.subarray(dataStart, dataEnd), type);
      if (parsed?.compressed) sawCompressed = true;
      if (parsed?.keyword === 'chara') {
        if (parsed.text === null) {
          throw new Error('角色卡数据是压缩过的 iTXt，当前不支持解压，请改用 JSON 导出');
        }
        return JSON.parse(decodeBase64Utf8(parsed.text));
      }
    }

    if (type === 'IEND') break;
    offset = dataEnd + 4;   // 跳过 4 字节 CRC
  }

  throw new Error(sawCompressed
    ? '找到了角色卡块，但内容是压缩的 iTXt，当前不支持解压'
    : '这个 PNG 里没有角色卡数据（找不到 chara 块）');
}

/** 一步到位：PNG 字节 → 内部角色 */
export function importPngCard(input) {
  const raw = readPngCard(input);
  return { ...importCharacterCard(raw), raw };
}
