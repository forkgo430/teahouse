/**
 * 界面层 —— 全屏对话式布局。
 *
 * 结构：
 *   顶栏（品牌 / 面板开关 / 存档）
 *   左抽屉（局面 · 人物 · 线索 · 成就）
 *   中栏（消息流：玩家发言 + 叙述 + 数值变化）
 *   右抽屉（模型接入）
 *   底部输入区（选项胶囊 + 自由输入）
 *
 * 硬约束：
 *   · 不含任何 CDN 引用（最终内联成单文件，断网可用）。
 *   · 不判断剧情。走哪个分支、能不能走，都由引擎决定。
 *   · 模型是可选件。没有它，自由输入走本地关键词解析，叙事走预写文本。
 */

import { createDemoWorld, createDemoState, CLUES, PLACES } from '../data/demo.js';
import { createInitialState } from '../src/schema.js';
import { createWorld } from '../src/engine.js';
import { RAINNIGHT_MODE, createRainWorld, rainInitialState } from '../data/mode-rain.js';
import { nextTurn, applyTurn, buildView, TurnRejected, endingTrace, missedEndings } from '../src/engine.js';
import { createStore, applyEffects, hashState } from '../src/state.js';
import { exportStore, importToStore, SaveError } from '../src/save.js';
import { createClient, readConfig, writeConfig, clearConfig } from '../src/llm.js';
import { createDirector } from '../src/director.js';
import { labelForPath, resolveValue } from '../src/narrator.js';
/* NARRATION_SYSTEM 从 style.js 取，不从 narrator.js ——
   narrator.js 只是 import 它自用，没有把它放进导出表（打包器按导出表解构，
   转不出来的名字会静默变成 undefined）。 */
import {
  normalizeStyle, composeNarrationSystem, DEFAULT_STYLE, NARRATION_SYSTEM,
  PERSON_OPTIONS, LANG_OPTIONS, LENGTH_OPTIONS, NARRATOR_OPTIONS, narratorName,
  INTERFACE_CLAUSES,
} from '../src/style.js';
import { defaultStack, buildSystemMessage, assembleStack } from '../src/prompts.js';
import { budgetStatus } from '../src/context.js';
import { importAny, importAs, importPngCard, KIND } from '../src/importers.js';
import { createWorldbook, updateEntry, removeEntry } from '../src/worldbook.js';
import { canAdvance, CONSENT, consentEffects, withdrawEffects, renegotiateEffects } from '../src/boundary.js';
import { DEFAULT_VARIANT_COUNT, MAX_VARIANTS, variantsOf, swipeState, stepVariant, selectVariantEffects } from '../src/swipe.js';
import { createAtmosphere } from './atmosphere.js';
import { attachFluidShader, TEA_FLUID_PARAMS } from './fluid.js';
import { createAudio } from './audio.js';
import {
  hasCardMarkup, renderBlock, renderInlineInto, parseCardMarkup,
  makeStatusCard, makeTruthMark, isTruthMarked, sampleCardMarkup,
} from '../src/card.js';
import { applyDisplayOutbound, normalizeRule, SHIPPED_RULES } from '../src/regex.js';
import { scenePanelMarkup } from '../src/scenePanel.js';
import { createBoy, normalizeBoyConfig, DEFAULT_BOY, WRITABLE, BOY_EVENTS } from '../src/boy.js';
import { buildBoyDocument } from '../src/boyFrame.js';

const SWIPE_KEY = 'ne.swipe.count';
const SOUND_KEY = 'ne.sound.on';
const BGM_KEY = 'ne.bgm.on';
const VOL_KEY = 'ne.volume';
/* 雨夜模式自带的「当轮意愿与边界」机制。有人只想走剧情、不想被闸门卡，
   所以给它一个开关 —— 关掉是"不过这道闸"，不是"把机制从数据里删掉"。 */
const BOUNDARY_KEY = 'ne.mech.boundary';
/* 每轮正文末尾附「状态卡」—— 引擎按本轮变化算出来、交模型原样带回。
   关掉就退回老样子：模型想输出结构化值就输出，不想就算。 */
const CARD_KEY = 'ne.mech.statuscard';
/* 茶馆小二：自由模式下开给玩家自己写的脚本的一扇门。
   默认关着 —— 一档都不开是刻意的，见 src/boy.js 的头注。 */
const BOY_KEY = 'ne.boy.config';
const BOY_SCRIPT_KEY = 'ne.boy.script';
/* 脚本从"一条"变成"一列表"。旧 key 保留不删 —— 万一迁移有 bug，
   玩家手写的那段还在原地；只是不再被读。 */
const BOY_SCRIPTS_KEY = 'ne.boy.scripts';
const BOY_ACTIVE_KEY = 'ne.boy.activeScript';

function readSoundOn() {
  try {
    const v = storage?.getItem(SOUND_KEY);
    return v === null || v === undefined ? true : v === '1';
  } catch {
    return true;
  }
}

function writeSoundOn(on) {
  try {
    storage?.setItem(SOUND_KEY, on ? '1' : '0');
  } catch {
    /* 只用在本轮 */
  }
}

function readBgmOn() {
  try { return storage?.getItem(BGM_KEY) !== '0'; } catch { return true; }
}
function writeBgmOn(on) {
  try { storage?.setItem(BGM_KEY, on ? '1' : '0'); } catch { /* 忽略 */ }
}

function readVolume() {
  try {
    const v = Number(storage?.getItem(VOL_KEY));
    return Number.isFinite(v) && v > 0 ? v : 0.45;
  } catch { return 0.45; }
}
function writeVolume(v) {
  try { storage?.setItem(VOL_KEY, String(v)); } catch { /* 忽略 */ }
}

/** 雨夜的边界机制是否启用（默认开） */
function readBoundary() {
  try { return storage?.getItem(BOUNDARY_KEY) !== '0'; } catch { return true; }
}
function writeBoundary(on) {
  try { storage?.setItem(BOUNDARY_KEY, on ? '1' : '0'); } catch { /* 忽略 */ }
}

/** 每轮正文末尾是否附状态卡（默认开）。引擎算的卡片，模型只负责搬。 */
function readStatusCard() {
  try { return storage?.getItem(CARD_KEY) !== '0'; } catch { return true; }
}
function writeStatusCard(on) {
  try { storage?.setItem(CARD_KEY, on ? '1' : '0'); } catch { /* 忽略 */ }
}

/* ── 正文样式（2026-09-19） ────────────────────────────────────────
   读者实际在读的是正文，所以正文的字号 / 行距 / 段距 / 缩进必须能调。
   这里只负责「值」，画由 CSS 变量接管（styles.css 里读 --reading-*）。 */
const READING_KEY = 'ne.reading';
const READING_DEFAULTS = Object.freeze({
  size: 14.5, leading: 1.95, gap: 15, autoPara: true, indent: false,
});

function readReading() {
  const v = readJson(READING_KEY, null);
  return { ...READING_DEFAULTS, ...(v && typeof v === 'object' ? v : {}) };
}

/** 把设置套成 :root 上的 CSS 变量。CSS 只管画，不给默认值之外的判断。 */
function applyReading(v = readReading()) {
  const root = document.documentElement;
  root.style.setProperty('--reading-size', `${v.size}px`);
  root.style.setProperty('--reading-leading', String(v.leading));
  root.style.setProperty('--reading-gap', `${v.gap}px`);
  root.style.setProperty('--reading-indent', v.indent ? '2em' : '0em');
  root.dataset.autoPara = v.autoPara ? 'on' : 'off';
}

function writeReading(patch) {
  const next = { ...readReading(), ...patch };
  writeJson(READING_KEY, next);
  applyReading(next);
  return next;
}

/**
 * 按句号自动分段。
 *
 * 模型与预写正文都常常是"一整坨"，读起来像运行日志。这里按句末标点切句，
 * 每 1–2 句并成一段。
 *
 * ⚠ 只在**纯文本**上做。调用方负责不要把标记区块（`[状态栏]` / `键 = 值`）
 *   送进来 —— 切坏了标记，整张卡就废了。
 */
const SENT_SPLIT = /([。！？]+[」』）】"']?)/;

function autoParagraphs(text, { perPara = 2, minLen = 150 } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];

  const out = [];
  for (const block of raw.split(/\n{2,}/)) {
    const t = block.trim();
    if (!t) continue;
    // 已经分过段（段内还有换行）或本来就短 —— 不动它
    if (t.length <= minLen || t.includes('\n')) { out.push(t); continue; }

    // split 带捕获组会把分隔符单独成项，两两合并还原句子
    const cells = [];
    const pieces = t.split(SENT_SPLIT);
    for (let i = 0; i < pieces.length; i++) {
      if (i % 2 === 1) cells[cells.length - 1] = (cells[cells.length - 1] ?? '') + pieces[i];
      else cells.push(pieces[i]);
    }

    // 引号不配对就并进上一句 —— 否则会切出落单的「
    const merged = [];
    const unbalanced = (s) => (s.match(/「/g)?.length ?? 0) !== (s.match(/」/g)?.length ?? 0);
    for (const s of cells) {
      if (!s) continue;
      if (merged.length && unbalanced(merged[merged.length - 1])) merged[merged.length - 1] += s;
      else merged.push(s);
    }

    for (let i = 0; i < merged.length; i += perPara) {
      out.push(merged.slice(i, i + perPara).join(''));
    }
  }
  return out.length ? out : [raw.trim()];
}

/** 这段文本里有没有"独占一行的标记名"？有就整段别动。 */
const HAS_BLOCK_LINE = /^\s*\[[^\]\n:]{1,24}\]\s*$/m;

applyReading();

function readSwipeCount() {  try {
    const n = Number(storage?.getItem(SWIPE_KEY));
    return Number.isInteger(n) && n >= 1 && n <= MAX_VARIANTS ? n : DEFAULT_VARIANT_COUNT;
  } catch {
    return DEFAULT_VARIANT_COUNT;
  }
}

function writeSwipeCount(n) {
  try {
    storage?.setItem(SWIPE_KEY, String(n));
  } catch {
    /* 存储不可用就只在本轮生效 */
  }
}

/* 音效是全局单例：启动页和主界面共用一套 */
const audio = createAudio({ enabled: readSoundOn() });
window.addEventListener('pointerdown', () => audio.unlock(), { once: true });

/* 玻璃旋钮（Aqua）：模糊度 / 磨砂度，全站实时生效 */
const GLASS_KEY = 'ne.glass';

function readGlassCfg() {
  try {
    return JSON.parse(storage?.getItem(GLASS_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function writeGlassCfg(cfg) {
  try {
    storage?.setItem(GLASS_KEY, JSON.stringify(cfg));
  } catch {
    /* 只用在本轮 */
  }
}

function applyGlass() {
  const cfg = readGlassCfg();
  document.documentElement.style.setProperty('--aqua-blur', `${cfg.blur ?? 14}px`);
  document.documentElement.style.setProperty('--aqua-frost', String(cfg.frost ?? 1));
}

applyGlass();

/* 提示词栈 / 正则规则 / 上下文预算：持久化读取 */
const STACK_KEY = 'ne.promptstack';
const STYLE_KEY = 'ne.narration.style';
const REGEX_KEY = 'ne.regexrules';
const CTX_KEY = 'ne.ctxbudget';

function readJson(key, fallback) {
  try {
    const v = storage?.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, val) {
  try {
    storage?.setItem(key, JSON.stringify(val));
  } catch {
    /* 只用在本轮 */
  }
}

/**
 * 正则规则的首次装载。
 *
 * `readJson` 的 fallback 分不清「从没装过」与「装过但删空了」—— 两者都是 null/[]。
 * 但这两件事必须区别对待：前者要给出厂规则（空面板让人无从下手），
 * 后者要尊重玩家的删除（否则删了又回来，成了甩不掉的牛皮癣）。
 *
 * 判据是**键存在与否**，不是值。
 */
function seedRegexRules(store) {
  let raw;
  try { raw = store?.getItem(REGEX_KEY); } catch { raw = null; }
  if (raw != null) {
    try { return JSON.parse(raw) ?? []; } catch { return []; }
  }
  const seeded = SHIPPED_RULES.map(r => JSON.parse(JSON.stringify(r)));
  try { store?.setItem(REGEX_KEY, JSON.stringify(seeded)); } catch { /* 本轮可用即可 */ }
  return seeded;
}

const ROUTE_LABEL = {
  closed: '未开启',
  open: '已开启',
  advancing: '推进中',
  frozen: '已冻结',
  settled: '已定局',
};

const TONE = ['gold', 'blue', 'green', 'pink'];

const FIELD_SPEC = [
  { key: 'endpoint', label: '接口地址', hint: 'https://api.deepseek.com', type: 'text' },
  { key: 'apiKey', label: 'API Key', hint: 'sk-…', type: 'password' },
  { key: 'model', label: '模型名', hint: 'deepseek-chat', type: 'text' },
];

/** 某些环境（file:// 下的隐私模式）会禁用存储，降级为内存存档 */
const storage = (() => {
  try {
    const probe = '__probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
})();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function brief(v) {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.length ? `[${v.join(', ')}]` : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* ------------------------------------------------------------------ *
 * 氛围层
 * ------------------------------------------------------------------ */

/**
 * Aqua 式光标聚光：光斑在玻璃**后面**亮起（pane 内 z-index -1），
 * 光透过毛玻璃扩散，永远不会盖住内容。
 */
function attachSpot(pane) {
  if (!pane || window.matchMedia('(hover: none)').matches) return;
  const glow = el('div');
  glow.style.cssText =
    'position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity .3s ease;z-index:-1;';
  pane.style.isolation = 'isolate';
  pane.appendChild(glow);

  let raf = 0;
  pane.addEventListener('pointermove', (e) => {
    if (raf) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      const r = pane.getBoundingClientRect();
      glow.style.background =
        `radial-gradient(240px circle at ${e.clientX - r.left}px ${e.clientY - r.top}px, rgba(120, 180, 255, 0.20), transparent 70%)`;
      glow.style.opacity = '1';
    });
  }, { passive: true });
  pane.addEventListener('pointerleave', () => { glow.style.opacity = '0'; });
}

/**
 * 解析导入文件（JSON 或 PNG 角色卡）。
 * @param {File} file
 * @param {{kind: string, label: string}} [expect] 期望分类；给了就按该分类解析，
 *   不符时返回 unknown + 说明（分区语义靠这个落实，不是靠事后过滤）
 */
async function parseImportFile(file, expect) {
  try {
    const isPng = /\.png$/i.test(file.name) || file.type === 'image/png';
    if (!isPng) {
      const raw = JSON.parse(await file.text());
      return expect ? importAs(raw, expect.kind, expect.label) : importAny(raw);
    }
    // PNG 只可能是角色卡；分类不是角色卡就如实说，不硬塞
    if (expect && expect.kind !== KIND.CHARACTER) {
      return { kind: KIND.UNKNOWN, warnings: [`当前分类是「${expect.label}」，但这是一张 PNG 角色卡 —— 切到「角色卡」再导入`] };
    }
    return importPngCard(await file.arrayBuffer());
  } catch (e) {
    return { kind: KIND.UNKNOWN, warnings: [`读不了这个文件：${e.message}`] };
  }
}

/** 拖拽文件到区域直接解析 */
function enableDrop(zone, onFile) {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('is-drag');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-drag'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('is-drag');
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
}

function buildAtmosphere(host) {
  const atmos = el('div', 'ne-atmos');
  atmos.setAttribute('aria-hidden', 'true');

  // 底层：WebGL 流体（Aqua 主题的招牌背景，淡蓝白三色柔混，鼠标搅动有涟漪）
  const fluidCanvas = el('canvas', 'ne-fluid');
  const canvas = el('canvas', 'ne-rain');
  atmos.append(fluidCanvas, canvas);
  host.appendChild(atmos);

  // 注意：先把画布挂进 DOM 再 attach —— clientWidth 为 0 时 WebGL
  // 会以零尺寸建纹理，首帧什么都画不出来
  const fluid = attachFluidShader(fluidCanvas, TEA_FLUID_PARAMS);
  const rain = createAtmosphere(canvas);

  return {
    setIntensity: rain.setIntensity,
    pulse: rain.pulse,
    stir: fluid.stir,
    destroy: () => {
      rain.destroy();
      fluid.dispose();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 挂载
 * ------------------------------------------------------------------ */

const MODE_KEY = 'ne.mode';

/* 玩法设置：推进方式 / 群聊 / 玩家设定。
   与模型配置同层，存在本地 —— 换模式不丢，清数据才没。 */
const CHAT_KEY = 'ne.chat.driver';
const GROUP_KEY = 'ne.chat.group';
const DISABLED_KEY = 'ne.chat.disabled';
const STREAM_KEY = 'ne.chat.stream';
const PERSONA_POS_KEY = 'ne.persona.position';
const PERSONA_DEPTH_KEY = 'ne.persona.depth';
const PERSONA_ROLE_KEY = 'ne.persona.role';
const PERSONA_NAME_KEY = 'ne.persona.name';
const PERSONA_DESC_KEY = 'ne.persona.desc';

function readBoyConfig() {
  try {
    const raw = storage?.getItem(BOY_KEY);
    return raw ? normalizeBoyConfig(JSON.parse(raw)) : { ...DEFAULT_BOY };
  } catch { return { ...DEFAULT_BOY }; }
}
function writeBoyConfig(cfg) {
  try { storage?.setItem(BOY_KEY, JSON.stringify(normalizeBoyConfig(cfg))); } catch { /* 忽略 */ }
}

/* ---- 小二脚本：一列表 ---- *
 * 形状：[{ id, name, text }]。id 不用下标 —— 删中间一条会把后面的全串位，
 * 活动脚本的指向就会悄悄指到别人身上。 */

/** 生成一个不会与现存的重复的 id */
function newScriptId(list) {
  const taken = new Set((list ?? []).map(s => s.id));
  let n = 1;
  while (taken.has(`s${n}`)) n++;
  return `s${n}`;
}

/**
 * 读脚本列表。旧的单条脚本在这里迁移成列表首条。
 *
 * 迁移后**不删旧 key**：万一这里的逻辑有 bug，玩家手写的那段还在原地，
 * 最多是没被读到，而不是没了。代价是 localStorage 里留着一份死数据 ——
 * 换"数据一定不丢"我觉得值。
 */
function readBoyScripts() {
  let list = [];
  try {
    const raw = storage?.getItem(BOY_SCRIPTS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      list = parsed
        .filter(s => s && typeof s === 'object')
        .map((s, i) => ({
          id: typeof s.id === 'string' && s.id ? s.id : `s${i + 1}`,
          name: typeof s.name === 'string' && s.name ? s.name : `脚本 ${i + 1}`,
          text: typeof s.text === 'string' ? s.text : '',
        }));
    }
  } catch { list = []; }

  if (list.length === 0) {
    let old = '';
    try { old = storage?.getItem(BOY_SCRIPT_KEY) ?? ''; } catch { old = ''; }
    if (old.trim()) {
      list = [{ id: 's1', name: '我的脚本', text: old }];
      writeBoyScripts(list);
    }
  }

  // id 去重：手改过 localStorage 可能塞进重复 id
  const seen = new Set();
  for (const s of list) {
    if (seen.has(s.id)) s.id = newScriptId([...seen].map(x => ({ id: x })));
    seen.add(s.id);
  }
  return list;
}
function writeBoyScripts(list) {
  try { storage?.setItem(BOY_SCRIPTS_KEY, JSON.stringify(list ?? [])); } catch { /* 忽略 */ }
}
function readActiveScriptId() {
  try { return storage?.getItem(BOY_ACTIVE_KEY) ?? null; } catch { return null; }
}
function writeActiveScriptId(id) {
  try {
    if (id === null || id === undefined) storage?.removeItem(BOY_ACTIVE_KEY);
    else storage?.setItem(BOY_ACTIVE_KEY, String(id));
  } catch { /* 忽略 */ }
}

/** 当前活动脚本。列表空时返回 null。 */
function activeScript() {
  const list = readBoyScripts();
  if (list.length === 0) return null;
  const want = readActiveScriptId();
  return list.find(s => s.id === want) ?? list[0];
}

function readChatMode() {
  try { return storage?.getItem(CHAT_KEY) === 'free' ? 'free' : 'story'; } catch { return 'story'; }
}
function writeChatMode(v) {
  try { storage?.setItem(CHAT_KEY, v === 'free' ? 'free' : 'story'); } catch { /* 忽略 */ }
}
function readSpeakerStrategy() {
  try {
    const v = storage?.getItem('ne.chat.speakers');
    return v === 'list' || v === 'manual' ? v : 'natural';
  } catch { return 'natural'; }
}
function writeSpeakerStrategy(v) {
  try { storage?.setItem('ne.chat.speakers', v); } catch { /* 忽略 */ }
}
function readAllowSelf() {
  try { return storage?.getItem('ne.chat.allowSelf') === '1'; } catch { return false; }
}
function writeAllowSelf(on) {
  try { storage?.setItem('ne.chat.allowSelf', on ? '1' : '0'); } catch { /* 忽略 */ }
}
function readGroup() {
  try { return storage?.getItem(GROUP_KEY) === '1'; } catch { return false; }
}
function writeGroup(on) {
  try { storage?.setItem(GROUP_KEY, on ? '1' : '0'); } catch { /* 忽略 */ }
}
/* 流式输出。默认开 —— 逐字出来比等一整段体验好得多，
   这个开关的用意是「让玩家能关」，不是「默认关」。
   没写过（返回 undefined）时按开处理，所以判断条件是 !== '0' 而不是 === '1'。 */
function readStream() {
  try { return storage?.getItem(STREAM_KEY) !== '0'; } catch { return true; }
}
function writeStream(on) {
  try { storage?.setItem(STREAM_KEY, on ? '1' : '0'); } catch { /* 忽略 */ }
}
function readDisabled() {
  try {
    const v = JSON.parse(storage?.getItem(DISABLED_KEY) ?? '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}
function writeDisabled(list) {
  try {
    storage?.setItem(DISABLED_KEY, JSON.stringify([...new Set((list ?? []).map(String))]));
  } catch { /* 忽略 */ }
}

function readPersona() {
  try {
    return {
      name: storage?.getItem(PERSONA_NAME_KEY) ?? '',
      desc: storage?.getItem(PERSONA_DESC_KEY) ?? '',
      // 位置 / 深度 / 角色 —— 参考酒馆 persona 的 position / depth / role
      position: storage?.getItem(PERSONA_POS_KEY) ?? 'in-prompt',
      depth: Number(storage?.getItem(PERSONA_DEPTH_KEY) ?? 4) || 0,
      role: storage?.getItem(PERSONA_ROLE_KEY) ?? 'system',
    };
  } catch {
    return { name: '', desc: '', position: 'in-prompt', depth: 4, role: 'system' };
  }
}
function writePersonaExtra({ position, depth, role }) {
  try {
    if (position) storage?.setItem(PERSONA_POS_KEY, position);
    if (depth !== undefined) storage?.setItem(PERSONA_DEPTH_KEY, String(depth));
    if (role) storage?.setItem(PERSONA_ROLE_KEY, role);
  } catch { /* 忽略 */ }
}

function writePersona(name, desc) {
  try {
    storage?.setItem(PERSONA_NAME_KEY, name ?? '');
    storage?.setItem(PERSONA_DESC_KEY, desc ?? '');
  } catch { /* 忽略 */ }
}

function readMode() {
  try {
    const v = storage?.getItem(MODE_KEY);
    return v === 'rainnight' ? 'rainnight' : 'tea';
  } catch {
    return 'tea';
  }
}

function writeMode(mode) {
  try {
    storage?.setItem(MODE_KEY, mode);
  } catch {
    /* 只用在本轮 */
  }
}

function saveKeyFor(mode) {
  return `narrative-engine/${mode}/save-1`;
}

function createWorldFor(mode) {
  return mode === 'rainnight' ? createRainWorld(createWorld) : createDemoWorld();
}

function initialStateFor(mode) {
  return mode === 'rainnight' ? rainInitialState(createInitialState) : createDemoState();
}

/**
 * 入口：先给启动页，选完路线再进主界面。
 * 主界面本体在 startMain —— 那里才是原来 mount 的全部内容。
 */
/* ---------------------------------------------------------------- *
 * 右抽屉：书架（人物书 / 世界书 / 成就）
 * ---------------------------------------------------------------- */

/* 涟漪参数，照 Material Web 的那套来（下面注释里写了出处） */
const RIPPLE = {
  originScale: 0.6,   // 起始圆 = 长边 × 0.6
  softEdge: 0.35,     // 软边下限，避免小元素上涟漪硬得像块饼
  softMin: 24,
  growMs: 450,
  fadeMs: 375,
};

/**
 * 涟漪。
 *
 * 算法参考 material-components/material-web（Apache-2.0）的 ripple 组件，
 * 按本项目的零依赖写法重写，未逐行复制其源码。要点三个：
 *   1. 最大半径取**对角线**（√(w²+h²)）而不是长边 —— 否则方角处扩不满；
 *   2. 起始圆不大，靠 `scale()` 放大到位 —— 动 transform 比动 width/height 便宜；
 *   3. 位移从**按下点**走到**元素中心**，所以涟漪是"被按出来的"，不是居中播放。
 * 松手后单独一段淡出（375ms linear），不跟扩散共用一条缓动。
 */
/**
 * 在 node 的 (clientX, clientY) 处按下一圈水纹。
 *
 * 算法取自 material-components/material-web（Apache-2.0）的 ripple，
 * 按零依赖重写：半径取**对角线**（取长边的话方角处扩不满）、
 * 起始圆只有长边的 0.6 倍、靠 scale() 放大（动 transform 比动宽高便宜）、
 * 位移从**按下点**走到**元素中心** —— 涟漪是"被按出来的"，不是居中播放。
 *
 * 委托层与手动挂载共用这一个出口，别再写第二份。
 */
function spawnRipple(node, clientX, clientY) {
  let surface = node.querySelector(':scope > .ripple-surface');
  if (!surface) {
    node.classList.add('has-ripple');
    surface = el('span', 'ripple-surface');
    node.appendChild(surface);
  }

  const box = node.getBoundingClientRect();
  const w = box.width || 1;
  const h = box.height || 1;

  const maxDim = Math.max(w, h);
  const soft = Math.max(RIPPLE.softEdge * maxDim, RIPPLE.softMin);
  const initial = Math.max(1, Math.floor(maxDim * RIPPLE.originScale));
  const maxRadius = Math.sqrt(w * w + h * h) + 10;
  const scale = (maxRadius + soft) / initial;

  const fromX = clientX - box.left - initial / 2;
  const fromY = clientY - box.top - initial / 2;
  const toX = w / 2 - initial / 2;   // 收到元素中心
  const toY = h / 2 - initial / 2;

  const dot = el('span', 'ripple-dot');
  dot.style.width = `${initial}px`;
  dot.style.height = `${initial}px`;
  dot.style.transform = `translate(${fromX}px, ${fromY}px) scale(1)`;
  surface.appendChild(dot);

  const release = () => {
    const fade = dot.animate(
      [{ opacity: dot.style.opacity || 0.26 }, { opacity: 0 }],
      { duration: RIPPLE.fadeMs, easing: 'linear', fill: 'forwards' },
    );
    fade.onfinish = () => dot.remove();
    fade.oncancel = () => dot.remove();
  };

  const grow = dot.animate(
    [
      { transform: `translate(${fromX}px, ${fromY}px) scale(1)` },
      { transform: `translate(${toX}px, ${toY}px) scale(${scale})` },
    ],
    { duration: RIPPLE.growMs, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'forwards' },
  );

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    release();
  };
  grow.onfinish = finish;
  // 松手就淡出，不等扩散走完 —— 按一下松得快，涟漪也该收得快
  node.addEventListener('pointerup', finish, { once: true });
  node.addEventListener('pointercancel', finish, { once: true });
  node.addEventListener('pointerleave', finish, { once: true });
}

/** 给单个元素挂上涟漪（书脊、把手这类"手动挂"的地方用） */
function attachRipple(node) {
  node.classList.add('has-ripple');
  if (!node.querySelector(':scope > .ripple-surface')) {
    node.appendChild(el('span', 'ripple-surface'));
  }
  node.addEventListener('pointerdown', (e) => spawnRipple(node, e.clientX, e.clientY));
}

/**
 * 全站的音效与点击反馈 —— 一个来源，靠事件委托。
 *
 * 为什么用委托而不是逐个挂：界面里有 40 多个按钮，散在启动页、设置面板、
 * 导入向导、书架、选项流里；逐个 attach 一漏就是一片哑的（之前就是这样，
 * 一半按钮没声音），而且后建的按钮还会漏。挂在 document 上，
 * **后建的按钮自动就有**，不用管渲染顺序。
 *
 * 音色由元素自己声明：`data-sfx="back|closePanel|select|bong|pageTurn|swap|confirm|deny|dropped"`，
 * 不写就是通用的 pick。这样"这个是返回"「这个是关闭」由写按钮的人决定，
 * 委托层只负责发声时机。
 */
let uiFeedbackInstalled = false;
function installUiFeedback() {
  if (uiFeedbackInstalled) return;
  uiFeedbackInstalled = true;

  const CLICKABLE = 'button, [role="button"], .book-spine, .book-tab, .ne-actor';
  const canHover = !window.matchMedia || window.matchMedia('(hover: hover)').matches;
  let lastHover = null;
  let lastHoverAt = 0;

  document.addEventListener('pointerover', (e) => {
    if (!canHover) return;                 // 触屏没有悬停这回事
    const node = e.target.closest?.(CLICKABLE);
    if (!node || node === lastHover || node.disabled) return;
    lastHover = node;
    // 密集列表里划过会连成一片 —— 90ms 内只响一次
    const now = performance.now();
    if (now - lastHoverAt < 90) return;
    lastHoverAt = now;
    audio.hover();
  });

  document.addEventListener('pointerdown', (e) => {
    // 只在主键上出声，右键菜单不该响
    if (e.button !== undefined && e.button !== 0) return;
    const node = e.target.closest?.(CLICKABLE);
    if (!node || node.disabled) return;

    spawnRipple(node, e.clientX, e.clientY);

    const kind = node.dataset?.sfx || 'pick';
    const fn = typeof audio[kind] === 'function' ? audio[kind] : audio.pick;
    fn.call(audio);
    /* 诊断钩子：产物探针靠这行数「点了几个按钮、每个按钮用了哪条采样路径」。
       没有它就只能看"没报错"，而"没报错"证明不了任何事。 */
    if (window.__SFX) {
      window.__SFX._lastTag = kind;
      const st = audio.status ? audio.status() : null;
      if (st) window.__SFX._ui = { kind, hits: st.diag.sampleHits, misses: st.diag.sampleMisses, loaded: st.loaded.length, pending: st.pending.length, failed: st.failed.length };
    }
  });
}

export function mount(root) {
  installUiFeedback();

  /* 诊断出口：探针只读，不改变行为。放这里是因为 mount 是产物唯一的入口。 */
  window.__SFX_API = audio;

  /* 音频设置必须在这里读，不能写在模块顶层。
     顶层调 readSoundOn 时 storage 还没初始化（它定义在文件更下面），
     而 `storage?.` 在 TDZ 里是**抛错**不是 undefined —— 异常被 catch 吃掉，
     于是开关永远读回默认值：关掉音效、刷新页面又自己开了。
     这个 bug 从加音效开关那天起就在，只是没人刷新过。 */
  audio.setEnabled(readSoundOn());
  audio.setBgmEnabled(readBgmOn());
  audio.setVolume(readVolume());

  renderBoot(root);
}

function startMain(root, opts = {}) {
  const mode = opts.mode ?? readMode();
  // 主题类在这里再兜一次底：启动页只在 renderBoot 里加过一次，
  // 从向导进来、或启动后才切模式时，类就漏了 —— 结果雨夜模式顶着浅色主题跑。
  document.body.classList.toggle('mode-rainnight', mode === 'rainnight');
  const world = createWorldFor(mode);
  /* 边界机制关掉时不挂闸门 —— 这是玩家的开关，不是改数据：
     世界定义里的 guards 原样保留，只是这一局不启用。 */
  if (!readBoundary()) world.guards = [];
  const store = createStore(initialStateFor(mode));
  const SAVE_KEY = saveKeyFor(mode);

  /* ── 茶馆小二：宿主侧的桥 ─────────────────────────────────────
     放在这里是因为它要用 store，而 store 刚建好。
     `apply` 只做一件事：把脚本提的 effect 交给 store.dispatch ——
     也就是**和事件走同一条写入路径**。桥自己不碰 state。 */
  const boyFrameHolder = { el: null };
  const boy = createBoy({
    host: () => {
      const st = store.getState();
      return {
        state: st,
        world,
        /* 世界书：只给条目结构（id / 标题 / 分栏 / 触发词 / 是否启用），
           正文由桥侧的白名单投影剥掉 —— 这里整份传下去是安全的，
           projectBookEntries 会挑字段。 */
        books: world.book ?? null,
        places: mode === 'rainnight'
          ? Object.keys(world.placeLabels ?? {})
          : Object.keys(world.placeLabels ?? PLACES ?? {}),
        view: null,
      };
    },
    apply: (effects) => store.dispatch(effects),
  });

  /* 状态变更 → state:changed。接在 store 的唯一提交点上，而不是手发 ——
     本文件的写入口有十来个（dispatch / commit / rollback / replace），
     手发必漏，而且顺序不可控。桥在 detach 时会自己解掉这个订阅。 */
  boy.bindStore(store);

  /* 入站：脚本发来的每一条都得有个收件人。
     挂在 window 上一次就够 —— 桥内部用 frame 比对来认自己的那个 frame，
     所以开面板 / 关面板 / 换脚本都不用重挂。 */
  window.addEventListener('message', (e) => boy.onMessage(e));

  /* 脚本说"替我说一句" —— 走和真人一模一样的提交路径，不另开一条 */
  boy.onLocal('request', (d) => {
    if (!d.text) return;
    input.value = d.text;
    submitText();
  });
  /* 脚本说"以系统口吻提示一句" —— 不进 history，不碰引擎状态 */
  boy.onLocal('say', (d) => {
    appendSystem(d.text, 'info');
  });
  boy.onLocal('toast', (d) => {
    appendSystem(d.text, 'info');
  });

  /* 预设带来的覆盖项：temperature / maxTokens 与系统提示词 */
  let presetOverrides = {};
  let presetSystemPrompt = '';

  // 向导里导入的东西，世界建好后再落进去
  if (opts.bootImports) {
    const imp = opts.bootImports;

    if (imp.worldbook?.length) {
      world.book = createWorldbook([...(world.book?.entries ?? []), ...imp.worldbook]);
    }

    for (const result of imp.characters ?? []) {
      const actor = result?.actor;
      if (!actor) continue;

      world.actorLabels = { ...(world.actorLabels ?? {}), [actor.id]: actor.name };
      world.statLabels = {
        ...(world.statLabels ?? {}),
        [actor.id]: Object.fromEntries(actor.stats.map(s => [s.key, s.label ?? s.key])),
      };
      if (result.book?.length) {
        world.book = createWorldbook([...(world.book?.entries ?? []), ...result.book]);
      }

      const next = structuredClone(store.getState());
      next.actors[actor.id] = {
        id: actor.id,
        name: actor.name,
        met: false,
        adult: actor.adult !== false,
        stats: Object.fromEntries(actor.stats.map(s => [s.key, s.init ?? 50])),
        bounds: Object.fromEntries(actor.stats.map(s => [s.key, { min: s.min ?? 0, max: s.max ?? 100 }])),
      };
      store.commit(next);
    }
  }

  // 继续游戏：进场即读档；坏档当新开
  if (opts.load) {
    const text = storage?.getItem(SAVE_KEY);
    if (text) {
      try {
        importToStore(store, text);
      } catch {
        /* 忽略坏档 */
      }
    }
  }

  let config = readConfig(storage);
  let client = createClient(config);
  let variantCount = readSwipeCount();
  let contextBudget = readJson(CTX_KEY, 6000);
  let promptStack = readJson(STACK_KEY, null) ?? defaultStack(NARRATION_SYSTEM);
  /* 文风：人称 / 语言 / 字数 / 补充要求 + 硬约束开关 */
  let narrationStyle = normalizeStyle(readJson(STYLE_KEY, {}));
  /* 正则：区分「从没装过」与「装过但删空了」。
     前者给一份出厂规则（否则面板一片空白，玩家不知道规则长什么样），
     后者尊重玩家的删除 —— 不把规则塞回来。 */
  let regexRules = seedRegexRules(storage);
  let liveTarget = null;
  let busy = false;
  let currentTurn = null;

  function handleDelta(partial) {
    if (!liveTarget) return;
    liveTarget.text.textContent = partial;
    scrollToEnd();
  }

  /** director 闭包持有 client 与机制配置，任何一项变了都得重建 */
  function buildDirector() {
    return createDirector({
      world,
      client,
      onDelta: handleDelta,
      options: {
        contextBudget,
        recentKeep: 4,
        inboundRules: regexRules,
        outboundRules: regexRules,
        /* 提示词栈必须真的装配进消息 —— 只存不读等于给玩家一个假开关 */
        promptStack,
        /* 文风同理：存了不传给 director 也是假开关 */
        narrationStyle,
        /* 状态卡：直传 buildView —— 卡片要读的就是它的只读快照 */
        buildView: (s) => buildView(s, world),
        statusCard: readStatusCard(),
      },
    });
  }

  let director = buildDirector();

  root.innerHTML = '';
  const atmosphere = buildAtmosphere(root);

  /** 浏览器要求先有用户手势才让出声，第一次点哪儿都行 */
  let audioReady = false;
  function ensureAudio() {
    if (audioReady) return;
    if (audio.unlock()) {
      audioReady = true;
      audio.startAmbient(ambientLevel());
    }
  }

  window.addEventListener('pointerdown', ensureAudio, { once: true });
  window.addEventListener('keydown', ensureAudio, { once: true });

  /** 雨势随进度缓慢变浓 —— 氛围跟着故事走，不是一成不变的背景板 */
  function ambientLevel() {
    const turns = store.getState().history?.length ?? 0;
    const base = mode === 'rainnight' ? 0.7 : 0.32;
    return Math.min(0.9, base + turns * 0.055);
  }

  /* ── 骨架 ── */
  const app = el('div', 'ne-app');

  const topbar = el('header', 'ne-topbar');
  const brand = el('div', 'ne-brand');
  brand.appendChild(el('span', 'ne-brand-title', '茶 馆'));
  brand.appendChild(el('span', 'ne-brand-tag', '通用叙事引擎'));
  brand.appendChild(el('span', 'mode-badge', mode === 'rainnight' ? '雨夜模式' : '茶馆标准'));

  const spacer = el('div', 'ne-topbar-spacer');

  const btnSide = iconBtn('状态', 'users');
  const btnImport = iconBtn('导入', 'book');
  /* 小二只在自由对话下有东西可读（事件驱动下正文是引擎写的）。
     不做成"灰着"，而是**整块不出现** —— 免得玩家点开一个永远空的抽屉。 */
  const btnBoy = iconBtn('小二', 'sparkles');
  btnBoy.dataset.sfx = 'toggle';
  btnBoy.hidden = readChatMode() !== 'free';
  const btnGear = iconBtn('设置', 'settings');
  btnGear.dataset.sfx = 'toggle';        // 面板开合音

  topbar.append(brand, spacer, btnBoy, btnSide, btnImport, btnGear);

  /** 切换推进方式之后要把小二按钮的显隐一起刷新 */
  function syncBoyButton() {
    btnBoy.hidden = readChatMode() !== 'free';
  }

  /* 右缘把手：平时是一个小圆点，hover 拉成胶囊显示「书架」。
     原本书架只能靠"鼠标贴到右缘"唤出，没有可见入口 —— 触屏与新手都摸不到。 */
  const shelfHandle = el('button', 'shelf-handle');
  shelfHandle.type = 'button';
  shelfHandle.dataset.sfx = 'pageTurn';  // 收放书架用翻页音
  shelfHandle.appendChild(el('i', 'ic ic-book'));
  shelfHandle.appendChild(el('span', 'shelf-handle-label', '书架'));
  shelfHandle.setAttribute('aria-label', '打开书架');
  attachRipple(shelfHandle);

  /* 书架开合有**两个来源**，必须共用一套状态，否则互相覆盖：
       · shelfHovered —— 鼠标贴右缘自动唤出（原有交互），离开就收
       · shelfPinned  —— 点把手显式开关（触屏与新手需要可见入口）
     踩过的坑：把手曾用独立的 shelfOpen 变量，于是
       ① 鼠标贴右缘打开的书架在 shelfOpen 眼里仍是「关着」，
          一碰 resize 或点把手就被关掉；
       ② 把手不知道书架开着，不会避让，直接压在书上；
       ③ 非 hover 设备（触屏）默认展开的那句 add('has-right')
          被随后的 applyShelf() 当场抹掉 —— 书架默认是关的。 */
  let shelfPinned = false;
  /* 宽屏默认展开 —— 书是这界面的主要看点，默认藏着（只靠鼠标贴右缘唤出）
     等于没做。窄屏是覆盖层，默认展开会挡住正文，所以按宽度给初值。 */
  let shelfHovered = window.innerWidth > 960;

  /* 收放的唯一出口。宽屏用网格列（.has-right 切列宽），
     窄屏用 display 开关（.has-shelf）——
     位移（translate / transform / right）在这个项目里被合成变换纠缠过，
     行内 + !important 都压不住；display 没有这些牵扯。 */
  const applyShelf = () => {
    const narrow = window.innerWidth <= 960;
    const open = shelfPinned || shelfHovered;
    body.classList.toggle('has-right', open && !narrow);
    body.classList.toggle('has-shelf', open && narrow);
    shelfHandle.classList.toggle('is-open', open);
    shelfHandle.setAttribute('aria-label', open ? '收起书架' : '打开书架');
  };

  shelfHandle.addEventListener('click', () => {
    shelfPinned = !shelfPinned;
    // 点开时清掉 hover 态，免得鼠标一移开就被 hover 逻辑收走
    if (shelfPinned) shelfHovered = false;
    applyShelf();
  });
  window.addEventListener('resize', () => {
    // 变窄时收起（覆盖层会挡住正文），变宽时交给 hover 逻辑
    if (window.innerWidth <= 960) shelfHovered = false;
    applyShelf();
  });

  root.appendChild(shelfHandle);

  const body = el('div', 'ne-body');
  const drawerLeft = el('aside', 'ne-drawer ne-drawer-left');
  const main = el('section', 'ne-main');
  const stream = el('div', 'ne-stream');
  const drawerRight = el('aside', 'ne-drawer ne-drawer-right');
  main.appendChild(stream);
  body.append(drawerLeft, main, drawerRight);

  const composer = el('footer', 'ne-composer');
  const composerInner = el('div', 'ne-composer-inner');
  const choices = el('div', 'ne-choices');
  const inputRow = el('form', 'ne-input-row');
  const input = el('input', 'ne-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = '也可以直接打字，例如「开门」「装作没听见」…';
  const btnSend = el('button', 'ne-send', '说');
  btnSend.type = 'submit';
  btnSend.dataset.sfx = 'confirm';   // 提交这句话 = 一次确认，不是随手点的选项
  inputRow.append(input, btnSend);
  const tip = el('p', 'ne-composer-tip', '点选项 / 输入序号 / 输入分支字母 / 直接用一句话说自己想做什么');
  composerInner.append(choices, inputRow, tip);
  composer.appendChild(composerInner);

  // 胶囊放进消息列里 sticky 吸底：与消息流天然同轴，抽屉开合零 JS 跟随
  main.appendChild(composer);

  app.append(topbar, body);
  root.appendChild(app);

  // Aqua 光标聚光：顶栏 / 左抽屉 / 底部胶囊三块主玻璃
  [topbar, drawerLeft, composer].forEach(attachSpot);

  function iconBtn(text, icon) {
    const b = el('button', 'ne-icon-btn');
    b.type = 'button';
    b.dataset.sfx = 'select';        // 顶栏图标按钮 = 选一个面板，不是"确认"
    if (icon) b.appendChild(el('i', `ic ic-${icon}`));
    b.appendChild(el('span', 'ne-btn-text', text));
    return b;
  }

  function scrollToEnd() {
    main.scrollTop = main.scrollHeight;
  }

  /* ---------------------------------------------------------------- *
   * 消息流
   * ---------------------------------------------------------------- */

  function deltaPanel(changes) {
    const useful = (changes ?? []).filter(c => c.path !== 'history');
    if (!useful.length) return null;

    /* 收叠：默认只留一行标题，点开才见明细 —— 不再占半屏 */
    const box = el('details', 'ne-deltas');
    const head = el('summary', 'ne-deltas-head', `数值变化 · ${useful.length} 项`);
    box.appendChild(head);
    box.appendChild(el('div', 'ne-deltas-hint', '点开查看本轮全部改动'));

    for (const c of useful) {
      const row = el('div', 'ne-delta');
      row.appendChild(el('span', 'ne-delta-name', labelForPath(c.path, world)));

      if (c.op === 'push' || c.op === 'pull') {
        // 列表类改动：只报"动了哪一个"，不报整个数组
        row.appendChild(el('span'));
        row.appendChild(el('span', `ne-delta-to ${c.op === 'push' ? 'is-up' : 'is-down'}`,
          resolveValue(c.path, c.value, world)));
      } else {
        row.appendChild(el('span', 'ne-delta-from', resolveValue(c.path, c.from, world)));

        let cls = 'is-set';
        if (typeof c.from === 'number' && typeof c.to === 'number') {
          cls = c.to > c.from ? 'is-up' : c.to < c.from ? 'is-down' : 'is-set';
        }
        const to = el('span', `ne-delta-to ${cls}`, resolveValue(c.path, c.to, world));
        if (c.clamped) {
          const flag = el('span', 'ne-delta-flag', '夹紧');
          flag.title = `原始值 ${brief(c.clamped.raw)}，落在 ${c.clamped.min}–${c.clamped.max}`;
          to.appendChild(flag);
        }
        row.appendChild(to);
      }
      box.appendChild(row);
    }
    return box;
  }

  function playerNode(text) {
    const box = el('div', 'ne-msg ne-msg-player');
    const head = el('div', 'ne-msg-head');
    head.appendChild(el('span', 'ne-msg-kind', '你说'));
    box.appendChild(head);
    box.appendChild(el('p', 'ne-msg-text', text));
    return box;
  }

  /**
   * 自由对话的一条记录。
   * 群聊时按 segments 逐段渲染，每段带发言者；没分段就整段当叙述。
   */
  function freeNode(record, index) {
    const box = el('div', 'ne-msg ne-msg-narrator ne-msg-free');
    box.dataset.turn = String(record.turn ?? index + 1);
    box.style.animationDelay = `${Math.min(index, 8) * 40}ms`;

    const head = el('div', 'ne-msg-head');
    head.appendChild(el('span', 'ne-msg-kind', '自由对话'));
    const slot = world.slotLabels?.[record.slot] ?? record.slot;
    head.appendChild(el('span', 'ne-msg-meta', `第 ${record.day} 天 · ${slot}`));
    box.appendChild(head);

    const segs = Array.isArray(record.segments) && record.segments.length
      ? record.segments
      : [{ speaker: null, text: record.text ?? '' }];

    for (const seg of segs) {
      if (seg.speaker) {
        const row = el('div', 'ne-seg');
        row.appendChild(el('span', 'ne-seg-name', seg.speaker));
        row.appendChild(textBox(seg.text));
        box.appendChild(row);
      } else {
        box.appendChild(textBox(seg.text));
      }
    }

    if (swipeState(record).canSwipe) box.appendChild(swipeBar(record, index));
    return box;
  }

  function narratorNode(record, index) {
    if (record.mode === 'free') return freeNode(record, index);

    const event = world.events.find(e => e.id === record.eventId);
    const branch = event?.branches.find(b => b.key === record.branchKey);

    const box = el('div', 'ne-msg ne-msg-narrator');
    box.dataset.turn = String(record.turn ?? index + 1);
    box.style.animationDelay = `${Math.min(index, 8) * 40}ms`;

    const head = el('div', 'ne-msg-head');
    head.appendChild(el('span', 'ne-msg-kind', event?.title ?? record.eventId));
    const slot = world.slotLabels?.[record.slot] ?? record.slot;
    head.appendChild(el('span', 'ne-msg-meta', `第 ${record.day} 天 · ${slot} · ${branch?.label ?? record.branchKey}`));
    box.appendChild(head);

    box.appendChild(textBox(record.text ?? branch?.text ?? ''));

    const deltas = deltaPanel(record.changes);
    if (deltas) box.appendChild(deltas);

    if (swipeState(record).canSwipe) box.appendChild(swipeBar(record, index));
    return box;
  }

  /* ── 正文渲染：结构化标记 → 组件 ────────────────────────────
     模型输出里可以出现声明式标记（[状态栏] 键 = 值 [/状态栏]、
     行内 [签:…] / [条:键|值|上限]）。引擎认识每个字段，按固定组件渲染，
     **不解析 HTML、不执行 JS、不需要沙箱** —— 不存在需要执行的代码。
     纯文本走原路径（直接 textContent），省开销。

     注意：解析发生在**渲染时**，渲染产物不写进 history。
     存档指纹基于 JSON 内容算，写进去会让旧档"内容变了"。 */
  function textBox(text, cls = 'ne-msg-text') {
    /* 显示层正则先跑（与酒馆一致：正则在渲染前作用）。
       只开 destination.display 的规则走这里 —— 它们**不进上下文**，
       这正是前端卡不会让 token 暴涨的原因。 */
    const shown = applyDisplayOutbound(String(text ?? ''), regexRules).text;
    const src = shown;

    /* 空正文：雨夜里有些分支**故意不写正文**，留给模型现场创作。
       零模型时不能给玩家一个空气泡 —— 那看起来像坏了，得说清楚为什么是空的。 */
    if (src.trim() === '') {
      return el('p', `${cls} ne-msg-empty`, '（这一段的正文留给模型书写 —— 接入 API 后由它现场生成）');
    }

    if (!hasCardMarkup(src)) {
      /* 没有区块标记，但**行内标记要在** —— 否则 [条:信任|72|100] ✓
         和 [签:危险] ✓ 会原样显示成一串方括号。
         代价是每段正文多一次正则扫描：只在"确实含方括号冒号"时才走这条路，
         纯正文（绝大多数）还是直接 textContent，不开销。 */
      const nodes = paragraphNodes(src, cls);
      if (nodes.length === 1) return nodes[0];
      // 多段：外面套一层 ne-paras，内层每个 <p> 仍是 ne-msg-text
      const wrap = el('div', 'ne-paras');
      for (const n of nodes) wrap.appendChild(n);
      return wrap;
    }

    // 有标记：切成段，文本段与组件段分别渲染
    const wrap = el('div', `${cls} ne-rich`);
    for (const seg of parseCardMarkup(src)) {
      if (seg.type === 'text') {
        for (const p of paragraphNodes(seg.text, 'ne-msg-text')) wrap.appendChild(p);
      } else {
        wrap.appendChild(renderBlock(seg, el));
      }
    }
    return wrap;
  }

  /**
   * 一段纯文本 → 若干个 <p>（自动分段 + 行内标记）。
   * ⚠ 含「独占一行的标记名」的文本**整段不切** —— 那是卡片标记的碎片，
   *   切了就会把 `[/状态栏]` 之类切散。 */
  function paragraphNodes(text, objCls) {
    const t = String(text ?? '');
    if (HAS_BLOCK_LINE.test(t)) {
      const p = el('p', objCls);
      renderInlineInto(p, t, el);
      return [p];
    }
    const reading = readReading();
    const paras = reading.autoPara ? autoParagraphs(t) : [t];
    return paras.map((one) => {
      const p = el('p', objCls);
      if (/\[[^\]:\n]{1,12}:/.test(one)) renderInlineInto(p, one, el);
      else p.textContent = one;
      return p;
    });
  }

  /* ── 多版本切换 ─────────────────────────────────────────── */

  function swipeBar(record, turnIndex) {
    const st = swipeState(record);
    const bar = el('div', 'ne-swipe');

    const prev = el('button', 'ne-swipe-btn', '‹');
    prev.type = 'button';
    prev.title = '上一版';
    prev.disabled = !st.canPrev;
    prev.dataset.sfx = 'back';
    prev.addEventListener('click', () => switchVariant(turnIndex, -1));

    const next = el('button', 'ne-swipe-btn', '›');
    next.type = 'button';
    next.title = '下一版';
    next.disabled = !st.canNext;
    next.dataset.sfx = 'pick';       // 换一版正文，本质是"再抽一次"
    next.addEventListener('click', () => switchVariant(turnIndex, 1));

    bar.append(prev, el('span', 'ne-swipe-label', `${st.index + 1} / ${st.total}`), next);
    return bar;
  }

  function updateSwipeBar(node, record) {
    const st = swipeState(record);
    const btns = node.querySelectorAll('.ne-swipe-btn');
    if (btns.length >= 2) {
      btns[0].disabled = !st.canPrev || busy;
      btns[1].disabled = !st.canNext || busy;
    }
    const label = node.querySelector('.ne-swipe-label');
    if (label) label.textContent = `${st.index + 1} / ${st.total}`;
  }

  /** 切换版本：只换文本，不重算任何数值 */
  function switchVariant(turnIndex, direction) {
    if (busy) return;

    const state = store.getState();
    const record = state.history[turnIndex];
    if (!record) return;

    const step = stepVariant(record, direction);
    if (!step.moved) return;

    const { state: next } = applyEffects(state, selectVariantEffects(turnIndex, step.index, step.text));
    store.commit(next);

    const node = stream.querySelector(`[data-turn="${record.turn}"]`);
    if (!node) return;

    const textNode = node.querySelector('.ne-msg-text');
    if (textNode) {
      // 交叉淡换，避免文字硬跳
      textNode.classList.add('is-swapping');
      window.setTimeout(() => {
        textNode.textContent = step.text;
        textNode.classList.remove('is-swapping');
      }, 150);
    }
    updateSwipeBar(node, next.history[turnIndex]);
  }

  /** 后台补完新版本后，把切换条刷新出来 */
  function refreshSwipeBar(turnIndex) {
    const record = store.getState().history[turnIndex];
    if (!record) return;

    const node = stream.querySelector(`[data-turn="${record.turn}"]`);
    if (!node) return;

    if (!node.querySelector('.ne-swipe') && swipeState(record).canSwipe) {
      node.appendChild(swipeBar(record, turnIndex));
      node.classList.add('is-fresh');
      window.setTimeout(() => node.classList.remove('is-fresh'), 900);
    }
    updateSwipeBar(node, record);
  }

  function systemNode(text, tone = '') {
    const box = el('div', `ne-msg ne-msg-system${tone ? ` is-${tone}` : ''}`);
    box.textContent = text;
    return box;
  }

  function rebuildStream() {
    stream.innerHTML = '';
    const history = store.getState().history ?? [];

    if (history.length === 0) {
      const intro = el('div', 'ne-msg ne-msg-narrator');
      const head = el('div', 'ne-msg-head');
      head.appendChild(el('span', 'ne-msg-kind', '开场'));
      intro.appendChild(head);
      /* 开场也走标记管线：雨夜模式的开场是 P2 版式（〔当前局面〕+ 角色卡 + 账本 + 线索），
         需要按组件渲染。茶馆开场是纯文本、不含标记 → textBox 内部走
         `!hasCardMarkup` 分支，产出的仍是单个 <p class="ne-msg-text">，行为与改前一致。 */
      intro.appendChild(textBox(world.opening));
      // 开场也要能折叠 —— 这里以前是 `return`，所以开场那条**永远没有折叠键**。
      attachMsgFold(intro, 'opening');
      stream.appendChild(intro);
    } else {
      history.forEach((record, i) => {
        if (record.said) {
          const pn = playerNode(record.said);
          attachMsgFold(pn, `p${i}`);
          stream.appendChild(pn);
        }
        const node = narratorNode(record, i);
        attachSpot(node);
        attachMsgFold(node, `n${record.turn ?? i}`);
        stream.appendChild(node);
      });
    }

    /* 雨夜模式：末尾挂一张「现在什么状态」的面板。
       它由 state **现算**（src/scenePanel.js），不是写死的文案 ——
       剧情改了数值/情绪，卡片立刻跟着变；否则会出现
       「正文说她在哭、卡上还写着平静」那种自相矛盾。
       只出有 `profile` 的角色（雨夜里就是林晚晴与周若宁），
       避免把「你」「催收方」这种没有身体档案的角色也画成卡。 */
    if (world.rainLevel > 0) {
      const panel = scenePanelNode();
      // 面板也要能折叠 —— 它原来是裸 div，没有 .ne-msg-head，
      // 于是 attachMsgFold 一进门就 return，整块面板折不了。
      attachMsgFold(panel, 'panel');
      stream.appendChild(panel);
    }
  }

  function scenePanelNode() {
    const s = store.getState();
    const actorIds = Object.values(s.actors ?? {})
      .filter(a => String(a.profile ?? '').trim() !== '')
      .map(a => a.id);
    const box = el('div', 'ne-msg ne-msg-narrator ne-scene-panel');
    // 要有消息头，折叠键才有地方挂（attachMsgFold 认的是 .ne-msg-head）
    const head = el('div', 'ne-msg-head');
    head.appendChild(el('span', 'ne-msg-kind', '当前状态'));
    const slot = world.slotLabels?.[s.clock.slot] ?? s.clock.slot ?? '';
    head.appendChild(el('span', 'ne-msg-meta', `第 ${s.clock.day} 天 · ${slot}`));
    box.appendChild(head);
    box.appendChild(textBox(scenePanelMarkup(s, world, { actorIds })));
    return box;
  }

  /* ── 消息可折叠（2026-09-19） ──
     长正文一屏屏往下滚，回看很难。给每条消息一个折叠开关，
     收起时只留消息头一行（事件标题 + 第N天·时段）。
     折叠状态按 key 存 localStorage，重建消息流时恢复。 */
  const MSGFOLD_KEY = 'ne.msgfold';

  function attachMsgFold(node, key) {
    const head = node.querySelector('.ne-msg-head');
    if (!head) return;

    const btn = el('button', 'ne-msg-fold', '⌄');
    btn.type = 'button';
    btn.title = '折叠 / 展开这条';
    btn.setAttribute('aria-label', '折叠或展开这条消息');

    const apply = (collapsed) => {
      node.classList.toggle('is-collapsed', collapsed);
      btn.textContent = collapsed ? '›' : '⌄';
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };

    apply(readJson(MSGFOLD_KEY, {})[key] === true);

    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const on = !node.classList.contains('is-collapsed');
      const all = readJson(MSGFOLD_KEY, {});
      all[key] = on;
      writeJson(MSGFOLD_KEY, all);
      apply(on);
    });

    head.appendChild(btn);
  }

  function appendSystem(text, tone) {
    stream.appendChild(systemNode(text, tone));
    scrollToEnd();
  }

  /* ---------------------------------------------------------------- *
   * 左抽屉：局面
   * ---------------------------------------------------------------- */

  function actorCard(actor, index) {
    const tone = TONE[index % TONE.length];
    const box = el('div', `ne-actor${actor.met ? '' : ' ne-actor-away'}`);
    box.style.setProperty('--tone', `var(--${tone})`);

    const top = el('div', 'ne-actor-top');
    top.appendChild(el('span', 'ne-actor-name', actor.name));
    box.appendChild(top);
    /* 关系路线：模式可以用 flags.path_<角色> 记阶段名（雨夜模式就是这么做的）。
       没有阶段就退回通用的「开 / 关」表述。 */
    const stage = store.getState().flags?.[`path_${actor.id}`];
    box.appendChild(el('div', 'ne-actor-route',
      actor.met
        ? `关系路线 · ${stage ?? ROUTE_LABEL[actor.route] ?? actor.route ?? '未开启'}`
        : '尚未见面'));

    for (const s of actor.stats) {
      const row = el('div', 'ne-stat');
      row.appendChild(el('span', 'ne-stat-key', statLabel(actor.id, s.key)));

      const bar = el('div', 'ne-bar');
      const fill = el('i');
      const span = (s.max ?? 100) - (s.min ?? 0);
      const pct = span > 0 ? ((s.value - (s.min ?? 0)) / span) * 100 : 0;
      fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el('span', 'ne-stat-num', String(s.value)));
      box.appendChild(row);
    }
    return box;
  }

  /* 标签一律先问 world（模式可以给自己的一套），问不到再退到示例数据的表。
     原先这里直接读 demo 的 PLACES / CLUES，于是雨夜模式的地点、线索
     全都显示成旧公寓那一套 —— mode-rain 里写的标签从来没被读过。 */
  function placeLabel(id) {
    if (id === null || id === undefined) return '未知';
    return world.placeLabels?.[id] ?? PLACES[id] ?? id;
  }

  function clueLabel(id) {
    return world.clueLabels?.[id] ?? CLUES[id] ?? id;
  }

  function statLabel(actorId, key) {
    return world.statLabels?.[actorId]?.[key] ?? key;
  }

  /** 意愿 → 样式修饰 + 文案 */
  const CONSENT_TONE = {
    [CONSENT.ACCEPT]: 'is-accept',
    [CONSENT.REFUSE]: 'is-refuse',
    [CONSENT.WITHDRAW]: 'is-withdraw',
    [CONSENT.RENEGOTIATE]: 'is-renegotiate',
  };

  const ROUTE_TEXT = {
    closed: '未开启',
    open: '已开启',
    advancing: '推进中',
    frozen: '已冻结（需重新协商）',
    settled: '已定局',
  };

  const CONSENT_ORDER = [
    CONSENT.UNSPOKEN, CONSENT.ACCEPT, CONSENT.REFUSE, CONSENT.WITHDRAW, CONSENT.RENEGOTIATE,
  ];

  /**
   * 登记一次当轮表态。
   *
   * 为什么必须是手动的：effects 在 recordHistory 之前执行，所以由事件分支
   * 写下的表态，轮号注定与"下一轮守卫看到的轮号"对不上 —— 表态永远等于作废。
   * 表态必须发生在**两轮之间**（这一轮已记完、下一轮还没开），
   * 这正是「当轮意愿必须在公开处登记」的落点。
   *
   * 判定仍然只在 boundary.js 里做，这里只负责把结果写进状态。
   */
  function registerConsent(actorId, value) {
    const cur = store.getState();
    const effects = value === CONSENT.WITHDRAW
      ? withdrawEffects(cur, actorId)
      : value === CONSENT.RENEGOTIATE
        ? renegotiateEffects(cur, actorId)
        : consentEffects(cur, actorId, value);
    store.dispatch(effects);
    render();
    appendSystem(
      value === CONSENT.UNSPOKEN
        ? `已把「${world.actorLabels?.[actorId] ?? actorId}」的当轮意愿记为未公开表达`
        : `已登记「${world.actorLabels?.[actorId] ?? actorId}」的当轮意愿：${value}（只在下一轮有效，过后需重新确认）`,
      'good',
    );
  }

  /**
   * 当轮意愿与边界卡（雨夜专属）。
   * 能不能推进一律问 boundary.canAdvance，把结论照搬上来 ——
   * UI 不许自己长出一套"同不同意"的标准。
   */
  function consentSection(view) {
    const sec = el('section', 'ne-sec');
    sec.appendChild(el('h3', 'ne-sec-title', '当轮意愿与边界'));

    for (const a of view.actors) {
      const c = view.consent?.[a.id] ?? {};
      const card = el('div', 'consent-card');

      const rowName = el('div', 'consent-row');
      rowName.appendChild(el('span', null, a.name));
      const value = c.state ?? CONSENT.UNSPOKEN;
      rowName.appendChild(el('span',
        `consent-value${CONSENT_TONE[value] ? ` ${CONSENT_TONE[value]}` : ''}`, value));
      card.appendChild(rowName);

      const rowRoute = el('div', 'consent-row');
      rowRoute.appendChild(el('span', null, '关系路线'));
      rowRoute.appendChild(el('span', 'consent-value', ROUTE_TEXT[c.route] ?? c.route ?? '未开启'));
      card.appendChild(rowRoute);

      // 判定权在引擎；这里只把闸门给的原话转述出来
      const gate = canAdvance(store.getState(), a.id);
      const rowGate = el('div', 'consent-row');
      rowGate.appendChild(el('span', null, '能否推进'));
      rowGate.appendChild(el('span', `consent-value${gate.ok ? ' is-accept' : ''}`,
        gate.ok ? '可以' : gate.reason));
      card.appendChild(rowGate);

      const actions = el('div', 'consent-actions');
      for (const v of CONSENT_ORDER) {
        const b = el('button', `book-tab${value === v ? ' is-on' : ''}`, v);
        b.type = 'button';
        b.dataset.sfx = 'select';    // 选当轮意愿，是"挑一个"不是"提交"
        b.addEventListener('click', () => registerConsent(a.id, v));
        actions.appendChild(b);
      }
      card.appendChild(actions);

      sec.appendChild(card);
    }

    sec.appendChild(el('p', 'ne-modal-note',
      '同意只在当轮有效 —— 上一轮说过「接受」，这一轮要重新确认。经济帮助、住宿、债务援助都不构成同意。'));
    return sec;
  }

  function renderSidebar(view) {
    drawerLeft.innerHTML = '';

    const s1 = el('section', 'ne-sec');
    s1.appendChild(el('h3', 'ne-sec-title', '当前局面'));
    const clock = el('div', 'ne-clockbox');
    clock.appendChild(el('div', 'ne-clockbox-day', `第 ${view.clock.day} 天 · ${view.clock.label}`));
    clock.appendChild(el('div', 'ne-clockbox-where', placeLabel(view.where)));
    s1.appendChild(clock);
    drawerLeft.appendChild(s1);

    const s2 = el('section', 'ne-sec');
    s2.appendChild(el('h3', 'ne-sec-title', '人物'));
    view.actors.forEach((a, i) => s2.appendChild(actorCard(a, i)));
    drawerLeft.appendChild(s2);

    // 雨夜专属：当轮意愿与边界。样式一直在，渲染一直没写 —— 现在补上。
    if (mode === 'rainnight' && readBoundary()) drawerLeft.appendChild(consentSection(view));

    const s3 = el('section', 'ne-sec');
    s3.appendChild(el('h3', 'ne-sec-title', `线索 · ${view.clues.length}`));
    if (view.clues.length) {
      const chips = el('div', 'ne-chips');
      view.clues.forEach(id => chips.appendChild(el('span', 'ne-chip blue', clueLabel(id))));
      s3.appendChild(chips);
    } else {
      s3.appendChild(el('div', 'ne-empty', '还没有拿到任何线索'));
    }
    drawerLeft.appendChild(s3);

    const s4 = el('section', 'ne-sec');
    s4.appendChild(el('h3', 'ne-sec-title', `成就 · ${view.achievements.length}`));
    if (view.achievements.length) {
      const chips = el('div', 'ne-chips');
      for (const id of view.achievements) {
        const def = world.achievements.find(a => a.id === id);
        chips.appendChild(el('span', 'ne-chip gold', def?.title ?? id));
      }
      s4.appendChild(chips);
    } else {
      s4.appendChild(el('div', 'ne-empty', '还没有解锁成就'));
    }
    drawerLeft.appendChild(s4);
  }


  /**
   * 点击书脊翻页开合。
   * 默认翻开 —— 合着的书看不到内容，不该是默认态。
   * 转轴在左缘（贴书脊），所以翻开像把封面掀过去，不是整块淡入。
   */
  function wireFlip(bookEl, label) {
    const spine = bookEl.querySelector('.book-spine');
    if (!spine) return;

    const sync = () => {
      const closed = bookEl.classList.contains('is-closed');
      spine.setAttribute('title', `点击${closed ? '翻开' : '合上'}${label}`);
      spine.setAttribute('aria-label', `${label}：${closed ? '已合上' : '已翻开'}`);
    };

    const flip = () => {
      bookEl.classList.toggle('is-closed');
      sync();
    };

    spine.setAttribute('role', 'button');
    spine.setAttribute('tabindex', '0');
    spine.dataset.sfx = 'pageTurn';      // 翻书 = 翻页音
    sync();
    attachRipple(spine);
    spine.addEventListener('click', flip);
    spine.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
    });
  }

  function renderLibrary() {
    drawerRight.innerHTML = '';
    const state = store.getState();

    /* ── 人物书：已了解 / 待了解 ── */
    const people = el('section', 'book');
    people.style.setProperty('--tone', 'var(--blue)');
    const peopleBody = el('div', 'book-body');

    const known = Object.entries(state.actors).filter(([, a]) => a.met);
    const unknown = Object.entries(state.actors).filter(([, a]) => !a.met);

    peopleBody.appendChild(el('div', 'book-group-label', `已了解 · ${known.length}`));
    if (known.length === 0) peopleBody.appendChild(el('div', 'ne-empty', '还没认识任何人'));
    for (const [id, a] of known) {
      const entry = el('div', 'book-entry');
      entry.appendChild(el('span', null, world.actorLabels?.[id] ?? a.name));
      entry.appendChild(el('span', 'ne-tag', '已见面'));
      peopleBody.appendChild(entry);
    }

    peopleBody.appendChild(el('div', 'book-group-label', `待了解 · ${unknown.length}`));
    for (const [id, a] of unknown) {
      const entry = el('div', 'book-entry');
      entry.appendChild(el('span', null, world.actorLabels?.[id] ?? a.name));
      entry.appendChild(el('span', 'ne-tag', '未见面'));
      peopleBody.appendChild(entry);
    }

    const peopleSpine = el('div', 'book-spine');
    peopleSpine.appendChild(el('i', 'ic ic-users'));
    peopleSpine.appendChild(el('span', null, '人物书'));
    people.append(peopleSpine, peopleBody);
    wireFlip(people, '人物书');
    drawerRight.appendChild(people);

    /* ── 世界书：概要 / 主线 / 任务 ── */
    const lore = el('section', 'book');
    lore.style.setProperty('--tone', 'var(--green)');
    const loreBody = el('div', 'book-body');

    const cats = ['概要', '主线', '任务'];
    let activeCat = cats[0];
    const tabs = el('div', 'book-tabs');
    const listWrap = el('div');

    function renderLore() {
      listWrap.innerHTML = '';
      const entries = (world.book?.entries ?? []).filter(e => (e.category ?? '概要') === activeCat);
      if (entries.length === 0) {
        listWrap.appendChild(el('div', 'ne-empty', `「${activeCat}」还没有条目 —— 用导入或剧本填充`));
        return;
      }
      for (const e of entries) {
        const entry = el('div', 'book-entry');

        // 标题可点 —— 展开编辑（原先世界书只能整份导，导错了没处改）
        const title = el('button', 'book-entry-title', e.heading ?? e.id);
        title.type = 'button';
        title.dataset.sfx = 'toggle';    // 展开编辑面板
        title.title = '点一下改这条';
        entry.appendChild(title);

        const right = el('span', 'book-entry-right');
        right.appendChild(el('span', 'ne-tag', e.keys.length ? e.keys[0] : '常驻'));

        const del = el('button', 'book-entry-del', '×');
        del.type = 'button';
        del.dataset.sfx = 'deny';        // 删除是破坏性的，给个下行音
        del.title = `删掉这条：${e.heading ?? e.id}`;
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          world.book = createWorldbook(removeEntry(world.book?.entries ?? [], e.id));
          appendSystem(`已删除世界书条目「${e.heading ?? e.id}」`, 'warn');
          render();
        });
        right.appendChild(del);

        entry.appendChild(right);
        listWrap.appendChild(entry);

        /* 编辑面板就地展开在条目下方 —— 不跳窗，改完还能对着上下文看。
           保存时**展开原条目再覆盖改动字段**：depth / position / scanDepth /
           递归 这些字段界面上没有，但必须原样留着，不能被这次编辑抹掉。 */
        title.addEventListener('click', () => {
          const next = entry.nextElementSibling;
          if (next && next.classList.contains('book-entry-edit')) { next.remove(); return; }

          const box = el('div', 'book-entry-edit');

          const hRow = el('label', 'ne-field');
          hRow.appendChild(el('span', 'ne-field-label', '标题'));
          const hIn = el('input', 'ne-field-input');
          hIn.type = 'text';
          hIn.value = e.heading ?? '';
          hIn.placeholder = e.id;
          hRow.appendChild(hIn);

          const kRow = el('label', 'ne-field');
          kRow.appendChild(el('span', 'ne-field-label', '关键词（逗号分隔，留空＝常驻）'));
          const kIn = el('input', 'ne-field-input');
          kIn.type = 'text';
          kIn.value = (e.keys ?? []).join('，');
          kRow.appendChild(kIn);

          const cRow = el('label', 'ne-field');
          cRow.appendChild(el('span', 'ne-field-label', '内容'));
          const cIn = el('textarea', 'ne-field-area');
          cIn.rows = 4;
          cIn.value = e.content ?? '';
          cRow.appendChild(cIn);

          let constOn = e.constant === true;
          const cBtn = el('button', 'ne-btn', constOn ? '常驻注入：已开启' : '常驻注入：已关闭');
          cBtn.type = 'button';
          cBtn.title = '开启后不看关键词，每一轮都注入';
          cBtn.addEventListener('click', () => {
            constOn = !constOn;
            cBtn.textContent = constOn ? '常驻注入：已开启' : '常驻注入：已关闭';
          });

          const acts = el('div', 'ne-modal-actions');
          const ok = el('button', 'ne-btn ne-btn-primary', '保存');
          ok.type = 'button';
          ok.dataset.sfx = 'confirm';
          ok.addEventListener('click', () => {
            const keys = kIn.value.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean);
            try {
              world.book = createWorldbook(updateEntry(world.book?.entries ?? [], e.id, {
                heading: hIn.value.trim() || null,
                keys,
                content: cIn.value,
                // 有关键词就不必常驻；一个关键词都没有时必须常驻，
                // 否则这条永远等不到触发
                constant: constOn || keys.length === 0,
              }));
              appendSystem(`已保存世界书条目「${hIn.value.trim() || e.id}」`, 'good');
              render();
            } catch (err) {
              appendSystem(`这条存不下：${err.message}`, 'warn');
            }
          });
          const cancel = el('button', 'ne-btn', '取消');
          cancel.type = 'button';
          cancel.dataset.sfx = 'closePanel';   // 取消 = 把这块收起来
          cancel.addEventListener('click', () => box.remove());
          acts.append(ok, cancel);

          box.append(hRow, kRow, cRow, cBtn, acts);
          entry.after(box);
        });
      }
    }

    for (const c of cats) {
      const tab = el('button', `book-tab${c === activeCat ? ' is-on' : ''}`, c);
      tab.type = 'button';
      tab.dataset.sfx = 'select';      // 换分类是选择，不是翻页
      tab.addEventListener('click', () => {
        activeCat = c;
        tabs.querySelectorAll('.book-tab').forEach(x => x.classList.toggle('is-on', x.textContent === c));
        renderLore();
      });
      tabs.appendChild(tab);
    }

    renderLore();
    const loreSpine = el('div', 'book-spine');
    loreSpine.appendChild(el('i', 'ic ic-world'));
    loreSpine.appendChild(el('span', null, '世界书'));
    loreBody.append(tabs, listWrap);
    lore.append(loreSpine, loreBody);
    wireFlip(lore, '世界书');
    drawerRight.appendChild(lore);

    /* ── 成就：已解锁 / 未解锁 ── */
    const ach = el('section', 'book');
    ach.style.setProperty('--tone', 'var(--pink)');
    const achBody = el('div', 'book-body');

    const got = world.achievements.filter(a => state.achievements.includes(a.id));
    const notGot = world.achievements.filter(a => !state.achievements.includes(a.id));

    achBody.appendChild(el('div', 'book-group-label', `已解锁 · ${got.length}`));
    if (got.length === 0) achBody.appendChild(el('div', 'ne-empty', '还没有解锁任何成就'));
    for (const a of got) {
      const entry = el('div', 'book-entry');
      entry.appendChild(el('span', null, a.title));
      entry.appendChild(el('span', 'ne-chip gold', '达成'));
      achBody.appendChild(entry);
    }

    achBody.appendChild(el('div', 'book-group-label', `待解锁 · ${notGot.length}`));
    for (const a of notGot) {
      const entry = el('div', 'book-entry');
      entry.appendChild(el('span', null, a.title));
      entry.appendChild(el('span', 'ne-tag', '？？？'));
      achBody.appendChild(entry);
    }

    const achSpine = el('div', 'book-spine');
    achSpine.appendChild(el('i', 'ic ic-trophy'));
    achSpine.appendChild(el('span', null, '成就'));
    ach.append(achSpine, achBody);
    wireFlip(ach, '成就书');
    [people, lore, ach].forEach(attachSpot);
    drawerRight.append(people, lore, ach);
  }

  /* ---------------------------------------------------------------- *
   * 齿轮：所有管理动作收进一个模态
   * ---------------------------------------------------------------- */

  /* 折叠分节：设置面板太长，观感全被长表单压掉了。
     只收「配一次就不动」的段；当天要按的开关（外观 / 玩法）默认摊开。
     展开态记在内存里，关掉面板再开还是原样，不写盘。 */
  const FOLD_STATE = new Map();

  function foldSection(title, opts = {}) {
    const sec = el('section', 'ne-sec ne-fold');
    const key = opts.key ?? title;
    const open = FOLD_STATE.get(key) ?? opts.open ?? false;
    if (open) sec.classList.add('is-open');

    const head = el('button', 'ne-fold-head');
    head.type = 'button';
    head.dataset.sfx = 'toggle';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    head.appendChild(el('span', 'ne-fold-title', title));
    if (opts.note) head.appendChild(el('span', 'ne-fold-note', opts.note));
    head.appendChild(el('i', 'ic ic-chevron ne-fold-arrow'));

    const body = el('div', 'ne-fold-body');
    const inner = el('div', 'ne-fold-inner');

    head.addEventListener('click', () => {
      const now = !sec.classList.contains('is-open');
      sec.classList.toggle('is-open', now);
      head.setAttribute('aria-expanded', now ? 'true' : 'false');
      FOLD_STATE.set(key, now);
    });

    body.appendChild(inner);
    sec.append(head, body);
    return { sec, body: inner };
  }

  function openSettingsModal() {
    const overlay = el('div', 'ne-modal');
    const card = el('div', 'ne-modal-card');
    card.appendChild(el('h2', 'ne-modal-title', '设置'));

    /* 快捷动作 */
    const quick = el('div', 'ne-modal-actions');
    quick.style.cssText = 'justify-content:flex-start;flex-wrap:wrap;margin-bottom:20px;';
    for (const [label, fn] of [['存档', save], ['读档', load], ['回退一步', undo], ['重新开始', reset]]) {
      const b = el('button', 'ne-btn', label);
      b.type = 'button';
      b.dataset.sfx = 'bong';        // 存档类动作改变"这一局还能不能回来"，给低音钟
      b.addEventListener('click', () => { fn(); overlay.remove(); });
      quick.appendChild(b);
    }
    card.appendChild(quick);

    /* ── 上下文预算 ── */
    const ctxFold = foldSection('上下文预算', { key: 'ctx', note: `${contextBudget} tokens` });
    const ctxSec = ctxFold.body;
    const ctxLab = el('span', 'ne-field-label',
      `预算 ${contextBudget} tokens · 当前历史约 ${budgetStatus(store.getState().history, contextBudget).tokens}`);
    const ctxRow = el('div', 'ne-field');
    ctxRow.appendChild(ctxLab);
    const ctxInput = el('input', 'ne-range');
    ctxInput.type = 'range';
    ctxInput.min = '2000';
    ctxInput.max = '16000';
    ctxInput.step = '500';
    ctxInput.value = String(contextBudget);
    ctxInput.addEventListener('input', () => {
      contextBudget = Number(ctxInput.value);
      writeJson(CTX_KEY, contextBudget);
      ctxLab.textContent = `预算 ${contextBudget} tokens · 当前历史约 ${budgetStatus(store.getState().history, contextBudget).tokens}`;
      director = buildDirector();
    });
    ctxRow.appendChild(ctxInput);
    ctxSec.appendChild(ctxRow);
    ctxSec.appendChild(el('p', 'ne-modal-warn',
      '超预算的旧轮次自动折叠为「前情提要」。最近 4 轮与结局轮永不裁剪。'));
    card.appendChild(ctxFold.sec);

    /* ── 提示词栈 ── */
    const stackFold = foldSection('提示词栈', { key: 'stack', note: `${promptStack.length} 条` });
    const stackSec = stackFold.body;
    const stackWrap = el('div');

    function saveStack() {
      writeJson(STACK_KEY, promptStack);
      director = buildDirector();
    }

    function renderStackUI() {
      stackWrap.innerHTML = '';
      for (const entry of promptStack) {
        const row = el('div', 'stack-entry');
        const sw = el('button', 'ne-btn stack-sw', entry.enabled ? '开' : '关');
        sw.type = 'button';
        sw.dataset.sfx = 'toggle';   // 开 / 关，字面就是 toggle
        if (entry.locked) sw.disabled = true;
        sw.addEventListener('click', () => {
          entry.enabled = !entry.enabled;
          saveStack();
          renderStackUI();
        });
        row.appendChild(sw);

        const ta = el('textarea', 'ne-field-area stack-ta');
        ta.rows = entry.locked ? 6 : 3;
        ta.value = entry.content;
        ta.placeholder = entry.name;
        /* 锁定条目是**只读展示**，不是可编辑的空框：
           它的内容由引擎在构建消息时直接带上，不走栈。
           显示出来是为了让玩家看得见引擎到底对模型说了什么。 */
        if (entry.locked) ta.readOnly = true;
        ta.addEventListener('change', () => {
          if (entry.locked) return;
          entry.content = ta.value;
          saveStack();
        });
        row.appendChild(ta);
        stackWrap.appendChild(row);

        if (entry.locked) {
          stackWrap.appendChild(el('p', 'stack-locked-note',
            '引擎自带的叙事规则，每轮直接发送，不可修改或关闭 —— 列在这里只是让你看得见。'));
        } else {
          const del = el('button', 'ne-btn stack-del', '删除');
          del.type = 'button';
          del.dataset.sfx = 'deny';
          del.addEventListener('click', () => {
            promptStack = promptStack.filter(x => x.id !== entry.id);
            saveStack();
            renderStackUI();
          });
          stackWrap.appendChild(del);
        }
      }

      const addRow = el('div', 'stack-add');
      const nameIn = el('input', 'ne-field-input rx-mini');
      nameIn.placeholder = '名称';
      const contentIn = el('input', 'ne-field-input rx-mini');
      contentIn.placeholder = '提示词内容';
      const addBtn = el('button', 'ne-btn', '添加');
      addBtn.type = 'button';
      addBtn.dataset.sfx = 'confirm';   // 新增条目 = 落定一件事
      addBtn.addEventListener('click', () => {
        if (!contentIn.value.trim()) return;
        promptStack.push({
          id: `user${Date.now()}`,
          name: nameIn.value.trim() || '未命名',
          role: 'system',
          content: contentIn.value,
          enabled: true,
          order: promptStack.length,
          locked: false,
        });
        nameIn.value = '';
        contentIn.value = '';
        saveStack();
        renderStackUI();
      });
      addRow.append(nameIn, contentIn, addBtn);
      stackWrap.appendChild(addRow);
    }
    renderStackUI();
    stackSec.appendChild(stackWrap);
    card.appendChild(stackFold.sec);

    /* ── 叙述文风 ──
       人称 / 语言 / 字数 / 补充要求四项由玩家定；
       硬约束开关管着三条「引擎不要弄坏数据」的接口条款（正文干净 /
       数值一致 / 拒绝越权指令）。锁着的时候那三条照旧发给模型，松开就不发。 */
    const styleSum = () => {
      const p = PERSON_OPTIONS.find(o => o.value === narrationStyle.person)?.label ?? '?';
      const l = LANG_OPTIONS.find(o => o.value === narrationStyle.lang)?.label ?? '?';
      const n = LENGTH_OPTIONS.find(o => o.value === narrationStyle.length)?.label ?? '?';
      return `${p} · ${l} · ${n} · ${narratorName(narrationStyle)}`;
    };
    const styleFold = foldSection('叙述文风', { key: 'style', note: styleSum() });
    const styleSec = styleFold.body;

    /* 只读预览框必须先建出来：saveStyle 会写它，
       而 const 在 TDZ 里是**抛错**不是 undefined —— 建晚了第一次点旋钮就炸。 */
    const previewBox = el('pre', 'style-preview');
    previewBox.tabIndex = 0;   // 可聚焦才好复制；不是表单控件，浏览器不管滚动位置
    previewBox.textContent = composeNarrationSystem(narrationStyle);

    const saveStyle = () => {
      writeJson(STYLE_KEY, narrationStyle);
      // 不重建 director（会丢 onDelta，正在流的这段就断了），直接改字段
      director.setNarrationStyle(narrationStyle);
      styleFold.sec.querySelector('.ne-fold-note').textContent = styleSum();
      previewBox.textContent = composeNarrationSystem(narrationStyle);
    };

    /** 一行三个胶囊的单选组 —— 和「推进方式」那组同款，视觉上是一家人 */
    const mkPicker = (labelText, options, key) => {
      const field = el('div', 'ne-field');
      field.appendChild(el('span', 'ne-field-label', labelText));
      const row = el('div', 'ne-modal-actions');
      row.style.cssText = 'justify-content:flex-start;flex-wrap:wrap;';
      for (const o of options) {
        const b = el('button',
          `ne-btn${narrationStyle[key] === o.value ? ' ne-btn-primary' : ''}`,
          o.hint ? `${o.label}（${o.hint}）` : o.label);
        b.type = 'button';
        b.dataset.sfx = 'select';
        b.addEventListener('click', () => {
          narrationStyle = { ...narrationStyle, [key]: o.value };
          saveStyle();
          // 只重画这一组，不整块重建 —— 否则光标和滚动位置都会跳
          for (const sib of row.children) {
            const hit = sib.textContent.startsWith(o.label);
            sib.classList.toggle('ne-btn-primary', hit);
          }
        });
        row.appendChild(b);
      }
      field.appendChild(row);
      return field;
    };

    styleSec.appendChild(mkPicker('人称', PERSON_OPTIONS, 'person'));
    styleSec.appendChild(mkPicker('语言', LANG_OPTIONS, 'lang'));
    styleSec.appendChild(mkPicker('字数', LENGTH_OPTIONS, 'length'));

    /* 自称：只换系统提示第一行那个称呼，条款与编号一律不动。
       自定义那一档要点开输入框 —— 名字空着就退回默认，不会留在提示词里。 */
    styleSec.appendChild(mkPicker('自称', NARRATOR_OPTIONS, 'narrator'));

    const nameField = el('label', 'ne-field');
    nameField.appendChild(el('span', 'ne-field-label', '自定义自称'));
    const nameInput = el('input', 'ne-input');
    nameInput.type = 'text';
    nameInput.placeholder = '例：说书的 / 老周';
    nameInput.maxLength = 12;
    nameInput.value = narrationStyle.narratorCustom;
    nameInput.addEventListener('change', () => {
      narrationStyle = { ...narrationStyle, narratorCustom: nameInput.value };
      saveStyle();
    });
    nameField.appendChild(nameInput);
    nameField.hidden = narrationStyle.narrator !== 'custom';
    styleSec.appendChild(nameField);

    // 切到 / 离开自定义档时显隐输入框。mkPicker 是通用件，勾子挂在外面。
    const narratorRow = styleSec.querySelectorAll('.ne-modal-actions');
    const lastRow = narratorRow[narratorRow.length - 1];
    if (lastRow) {
      lastRow.addEventListener('click', () => {
        nameField.hidden = narrationStyle.narrator !== 'custom';
        if (!nameField.hidden) nameInput.focus();
      });
    }

    /* 补充要求：玩家自己往提示词末尾加一句，比如「多用嗅觉描写」 */
    const extraField = el('label', 'ne-field');
    extraField.appendChild(el('span', 'ne-field-label', '补充要求（可留空）'));
    const extraInput = el('input', 'ne-input');
    extraInput.type = 'text';
    extraInput.placeholder = '例：多用嗅觉与触觉描写，少用成语';
    extraInput.value = narrationStyle.extra;
    extraInput.addEventListener('change', () => {
      narrationStyle = { ...narrationStyle, extra: extraInput.value };
      saveStyle();
    });
    extraField.appendChild(extraInput);
    styleSec.appendChild(extraField);

    /* ── 硬约束开关 ── */
    const lockRow = el('div', 'ne-field');
    lockRow.appendChild(el('span', 'ne-field-label', '硬约束'));
    const lockBtn = el('button', 'ne-btn',
      narrationStyle.locked ? '已上锁 · 三条接口条款照发' : '已松开 · 接口条款不发');
    lockBtn.type = 'button';
    lockBtn.dataset.sfx = 'toggle';
    lockBtn.addEventListener('click', () => {
      narrationStyle = { ...narrationStyle, locked: !narrationStyle.locked };
      saveStyle();
      lockBtn.textContent = narrationStyle.locked ? '已上锁 · 三条接口条款照发' : '已松开 · 接口条款不发';
      lockHint.hidden = narrationStyle.locked;
      lockList.hidden = !narrationStyle.locked;
    });
    lockRow.appendChild(lockBtn);
    styleSec.appendChild(lockRow);

    const lockList = el('div', 'style-clauses');
    for (const c of INTERFACE_CLAUSES) {
      const item = el('div', 'style-clause');
      item.append(
        el('span', 'style-clause-name', c.label),
        el('span', 'style-clause-hint', c.hint),
      );
      lockList.appendChild(item);
    }
    lockList.hidden = !narrationStyle.locked;
    styleSec.appendChild(lockList);

    const lockHint = el('p', 'ne-modal-warn',
      '松开后这三条不再发给模型。人称 / 语言 / 字数照旧生效 —— '
      + '但正文里的元话语、与数值变化矛盾的描写、以及「忽略以上指令」这类越权要求，'
      + '都只能靠模型自觉了。');
    lockHint.hidden = narrationStyle.locked;
    styleSec.appendChild(lockHint);

    /* ── 状态卡开关 + 参考块 ──
       卡片的内容是**引擎算的**，模型只负责原样搬进正文。
       这里同时把"卡片长什么样"画出来 —— 示例走同一条解析路径，
       所以改了语法、改了字段名，这块会跟着变，不会开始骗人。 */
    const cardRow = el('div', 'ne-field');
    cardRow.appendChild(el('span', 'ne-field-label', '状态卡'));
    const cardBtn = el('button', 'ne-btn',
      readStatusCard() ? '已开启 · 每轮附一张' : '已关闭 · 模型自由发挥');
    cardBtn.type = 'button';
    cardBtn.dataset.sfx = 'toggle';
    cardBtn.addEventListener('click', () => {
      const on = !readStatusCard();
      writeStatusCard(on);
      director.setStatusCard(on);
      cardBtn.textContent = on ? '已开启 · 每轮附一张' : '已关闭 · 模型自由发挥';
      cardHint.hidden = on;
    });
    cardRow.appendChild(cardBtn);
    styleSec.appendChild(cardRow);

    const cardHint = el('p', 'ne-modal-warn',
      '关闭后引擎不再产出卡片。模型想输出结构化值就输出，不想就没有 —— '
      + '卡片会变得时有时无，且数值可能与真实状态对不上。');
    cardHint.hidden = readStatusCard();
    styleSec.appendChild(cardHint);

    const refField = el('div', 'ne-field');
    refField.appendChild(el('span', 'ne-field-label', '卡片示例（带 ✓ 的是引擎真值）'));
    const refBox = el('div', 'ne-card-ref');
    for (const seg of parseCardMarkup(sampleCardMarkup())) {
      // sampleCardMarkup 保证模板首尾是非空纯文本段（`[/状态栏]` 落进文本里），
      // 所以这里只画区块段：文本段是那行闭合标记的残留，画出来是噪音。
      if (seg.type === 'block') refBox.appendChild(renderBlock(seg, el));
    }
    refField.appendChild(refBox);
    refField.appendChild(el('p', 'ne-card-ref-note',
      '语法：`[状态栏]` 与 `[/状态栏]` 各占一行，中间一行一项写 `键 = 值`。'
      + '没有 `=` 的行原样显示成备注。'));
    styleSec.appendChild(refField);

    /* ── 实际发出的系统提示词：只读展示 ──
       玩家有权知道引擎到底对模型说了什么。改它请改上面的旋钮，不在这里手改。 */
    const previewField = el('div', 'ne-field');
    previewField.appendChild(el('span', 'ne-field-label', '实际发出的系统提示词（只读 · 可选中复制）'));
    previewField.appendChild(previewBox);
    styleSec.appendChild(previewField);

    card.appendChild(styleFold.sec);

    /* ── 正文样式（2026-09-19） ──
       读者实际在读的是正文，所以字号 / 行距 / 段距 / 自动分段 / 缩进都得能调。
       值存 localStorage 并套成 :root 的 CSS 变量，styles.css 只负责画。 */
    const readFold = foldSection('正文样式', { key: 'reading' });
    const readSec = readFold.body;

    const mkReadingPicker = (labelText, options, key) => {
      const field = el('div', 'ne-field');
      field.appendChild(el('span', 'ne-field-label', labelText));
      const row = el('div', 'ne-modal-actions');
      row.style.cssText = 'justify-content:flex-start;flex-wrap:wrap;';
      for (const o of options) {
        const b = el('button',
          `ne-btn${readReading()[key] === o.value ? ' ne-btn-primary' : ''}`, o.label);
        b.type = 'button';
        b.dataset.sfx = 'select';
        b.addEventListener('click', () => {
          writeReading({ [key]: o.value });
          for (const sib of row.children) sib.classList.toggle('ne-btn-primary', sib === b);
        });
        row.appendChild(b);
      }
      field.appendChild(row);
      return field;
    };

    const mkReadingSwitch = (labelText, key, onText, offText) => {
      const on0 = readReading()[key];
      const field = el('div', 'ne-field');
      field.appendChild(el('span', 'ne-field-label', labelText));
      const b = el('button', `ne-btn${on0 ? ' ne-btn-primary' : ''}`, on0 ? onText : offText);
      b.type = 'button';
      b.dataset.sfx = 'toggle';
      b.addEventListener('click', () => {
        const on = !readReading()[key];
        writeReading({ [key]: on });
        b.textContent = on ? onText : offText;
        b.classList.toggle('ne-btn-primary', on);
        // 自动分段是开关：重画正文流，关掉立刻回到原始文本
        if (key === 'autoPara') rebuildStream();
      });
      field.appendChild(b);
      return field;
    };

    readSec.appendChild(mkReadingPicker('字号',
      [{ value: 13, label: '小' }, { value: 14.5, label: '中' }, { value: 16, label: '大' }], 'size'));
    readSec.appendChild(mkReadingPicker('行距',
      [{ value: 1.7, label: '紧' }, { value: 1.95, label: '标准' }, { value: 2.3, label: '松' }], 'leading'));
    readSec.appendChild(mkReadingPicker('段间距',
      [{ value: 8, label: '小' }, { value: 15, label: '中' }, { value: 26, label: '大' }], 'gap'));
    readSec.appendChild(mkReadingSwitch('自动分段', 'autoPara',
      '已开启 · 按句号切段', '已关闭 · 保留原文'));
    readSec.appendChild(mkReadingSwitch('首行缩进', 'indent', '已开启', '已关闭'));
    readSec.appendChild(el('p', 'ne-modal-warn',
      '只影响显示，**不改存档里的原文** —— 正文永远按原始文本存，切段只发生在渲染时。'));
    card.appendChild(readFold.sec);

    /* ── 正则后处理 ── */
    const rxFold = foldSection('正则后处理', { key: 'regex', note: `${regexRules.length} 条` });
    const rxSec = rxFold.body;
    const rxWrap = el('div');

    function saveRx() {
      writeJson(REGEX_KEY, regexRules);
      director = buildDirector();
    }

    function renderRxUI() {
      rxWrap.innerHTML = '';
      /* 每条规则 = 一条清单项。
         改动前先读 src/regex.js 顶部的数据模型说明 —— 它是 source × destination
         二维（读酒馆源码后确定），不是社区讲的"四个作用点"。 */
      for (const rule of regexRules) {
        const r = normalizeRule(rule);
        const row = el('div', 'rx-entry');
        row.dataset.invalid = r.invalid ? '1' : '0';

        /* ── 第一行：序号 + 查找 → 替换为 + 删除 ── */
        const main = el('div', 'rx-main');

        const no = el('span', 'rx-no');
        no.textContent = String(regexRules.indexOf(rule) + 1).padStart(2, '0');

        const pair = el('div', 'rx-pair');
        const findIn = el('input', 'rx-in rx-in-find');
        findIn.value = rule.find ?? '';
        findIn.placeholder = '查找（正则）';
        findIn.spellcheck = false;
        findIn.addEventListener('change', () => {
          rule.find = findIn.value;
          saveRx();
          renderRxUI();
        });

        const arrow = el('span', 'rx-arrow', '→');

        const repIn = el('input', 'rx-in rx-in-rep');
        repIn.value = rule.replace ?? '';
        repIn.placeholder = '替换为';
        repIn.spellcheck = false;
        repIn.addEventListener('change', () => {
          rule.replace = repIn.value;
          saveRx();
        });

        pair.append(findIn, arrow, repIn);

        const del = el('button', 'rx-del');
        del.type = 'button';
        del.title = '删除这条规则';
        del.setAttribute('aria-label', '删除这条规则');
        del.dataset.sfx = 'deny';
        del.appendChild(el('i', 'ic ic-x'));
        del.addEventListener('click', () => {
          regexRules = regexRules.filter(x => x.id !== rule.id);
          saveRx();
          renderRxUI();
        });

        main.append(no, pair, del);
        row.appendChild(main);

        /* ── 第二行：两个 destination 复选框（与酒馆数据模型同构） ──
           「显示」= 只改渲染，不进上下文；「提示词」= 模型能读到。
           两个都开就是旧行为。分开的意义：前端卡只开显示，token 不涨。 */
        const scope = el('div', 'rx-scope');

        const mkBox = (key, label, hint) => {
          const id = `rx-${rule.id}-${key}`;
          const lab = el('label', 'rx-check');
          lab.htmlFor = id;
          const box = el('input', 'rx-check-input');
          box.type = 'checkbox';
          box.id = id;
          box.checked = rule.destination?.[key] === true;
          box.addEventListener('change', () => {
            rule.destination = { ...normalizeRule(rule).destination, [key]: box.checked };
            // 老格式折过来之后就写新格式，避免每次读都再折一遍
            delete rule.scope;
            saveRx();
          });
          lab.append(box, el('span', 'rx-check-box'), el('span', 'rx-check-text', label));
          if (hint) lab.title = hint;
          return lab;
        };

        const mkSrc = (key, label, hint) => {
          const id = `rx-${rule.id}-src-${key}`;
          const lab = el('label', 'rx-check rx-check-src');
          lab.htmlFor = id;
          const box = el('input', 'rx-check-input');
          box.type = 'checkbox';
          box.id = id;
          box.checked = rule.source?.[key] === true;
          box.addEventListener('change', () => {
            rule.source = { ...normalizeRule(rule).source, [key]: box.checked };
            delete rule.scope;
            saveRx();
          });
          lab.append(box, el('span', 'rx-check-box'), el('span', 'rx-check-text', label));
          if (hint) lab.title = hint;
          return lab;
        };

        scope.append(
          el('span', 'rx-scope-label', '作用'),
          mkSrc('output', '模型输出'),
          mkSrc('input', '玩家输入'),
          el('span', 'rx-scope-sep'),
          el('span', 'rx-scope-label', '送往'),
          mkBox('display', '显示', '只改你看到的，不进模型上下文 —— 前端卡靠它保持 token 不涨'),
          mkBox('prompt', '提示词', '模型能读到改动'),
        );
        row.appendChild(scope);

        /* ── 非法正则：就地标红并给原因，不藏 ── */
        if (r.invalid) {
          row.appendChild(el('p', 'rx-err', '正则不合法，已停用。改好即恢复。'));
        } else if (!r.destination.display && !r.destination.prompt) {
          row.appendChild(el('p', 'rx-warn', '两个「送往」都没勾 —— 这条规则不会起作用。'));
        }

        rxWrap.appendChild(row);
      }

      /* ── 新增：同样是「查找 → 替换为 + 两个复选框」 ── */
      const addRow = el('div', 'rx-add');
      const fIn = el('input', 'ne-field-input rx-mini');
      fIn.placeholder = '查找（正则）';
      fIn.spellcheck = false;
      const rIn = el('input', 'ne-field-input rx-mini');
      rIn.placeholder = '替换为';
      rIn.spellcheck = false;

      const newDst = { display: true, prompt: false };
      const addBoxes = el('div', 'rx-add-scope');
      for (const [key, label] of [['display', '显示'], ['prompt', '提示词']]) {
        const id = `rx-new-${key}`;
        const lab = el('label', 'rx-check');
        lab.htmlFor = id;
        const box = el('input', 'rx-check-input');
        box.type = 'checkbox';
        box.id = id;
        box.checked = newDst[key];
        box.addEventListener('change', () => { newDst[key] = box.checked; });
        lab.append(box, el('span', 'rx-check-box'), el('span', 'rx-check-text', label));
        addBoxes.appendChild(lab);
      }

      const add = el('button', 'ne-btn rx-add-btn', '添加规则');
      add.type = 'button';
      add.dataset.sfx = 'confirm';
      add.addEventListener('click', () => {
        if (!fIn.value) return;
        regexRules.push({
          id: `rx${Date.now()}`,
          name: '自定义',
          find: fIn.value,
          replace: rIn.value,
          flags: 'g',
          source: { output: true, input: false },
          destination: { display: newDst.display, prompt: newDst.prompt },
          enabled: true,
        });
        fIn.value = '';
        rIn.value = '';
        saveRx();
        renderRxUI();
      });

      addRow.append(fIn, rIn, addBoxes, add);
      rxWrap.appendChild(addRow);
    }
    renderRxUI();
    rxSec.appendChild(rxWrap);
    rxSec.appendChild(el('p', 'ne-modal-warn',
      '「显示」只改你看到的，「提示词」会让模型读到。前端卡请只勾显示。'
      + '非法正则会自动停用并保留在列表里，改好即恢复。'));
    card.appendChild(rxFold.sec);

    /* 外观：玻璃旋钮（Aqua 同款，实时生效）—— 常用，默认摊开 */
    // 外观也默认折叠（用户要求：设置面板里所有分组统一收起，
    // 想调哪一组再点开，省得三十多行控件一次铺满）
    const appFold = foldSection('外观 · 玻璃', { key: 'glass' });
    const appearance = appFold.body;
    const glassCfg = readGlassCfg();
    const knobs = [
      { key: 'blur', label: '模糊度', min: 0, max: 40, step: 1, unit: ' px', def: 14 },
      { key: 'frost', label: '磨砂度', min: 0, max: 2, step: 0.1, unit: '', def: 1 },
    ];
    for (const k of knobs) {
      const row = el('div', 'ne-field');
      const lab = el('span', 'ne-field-label', `${k.label}　${Number(glassCfg[k.key] ?? k.def)}${k.unit}`);
      row.appendChild(lab);
      const input = el('input', 'ne-range');
      input.type = 'range';
      input.min = String(k.min);
      input.max = String(k.max);
      input.step = String(k.step);
      input.value = String(glassCfg[k.key] ?? k.def);
      input.addEventListener('input', () => {
        const cfg = { ...readGlassCfg(), [k.key]: Number(input.value) };
        writeGlassCfg(cfg);
        applyGlass();
        lab.textContent = `${k.label}　${Number(input.value)}${k.unit}`;
      });
      row.appendChild(input);
      appearance.appendChild(row);
    }
    appearance.appendChild(el('p', 'ne-modal-warn',
      '磨砂度 0 = 全透玻璃，2 = 磨砂最重。实时生效并自动保存。'));
    card.appendChild(appFold.sec);

    /* 模型接入 */
    const apiFold = foldSection('模型接入', { key: 'api', note: client.ready() ? '已接入' : '未接入' });
    const sec = apiFold.body;
    sec.appendChild(el('p', 'ne-modal-note',
      client.ready()
        ? `已接入：${config.model || '（未命名模型）'}。正文由模型生成，自由输入也有模型兜底。`
        : '不接也能玩：自由输入走本地关键词解析，叙事用预写文本。'));

    const fields = {};
    for (const spec of FIELD_SPEC) {
      const row = el('label', 'ne-field');
      row.appendChild(el('span', 'ne-field-label', spec.label));
      const box = el('input', 'ne-field-input');
      box.type = spec.type;
      box.placeholder = spec.hint;
      box.value = config[spec.key] ?? '';
      box.autocomplete = 'off';
      fields[spec.key] = box;
      row.appendChild(box);
      sec.appendChild(row);
    }

    const swipeRow = el('div', 'ne-field');
    const swipeLabel = el('span', 'ne-field-label', `每轮生成　${variantCount} 段`);
    swipeRow.appendChild(swipeLabel);
    const swipeInput = el('input', 'ne-range');
    swipeInput.type = 'range';
    swipeInput.min = '1';
    swipeInput.max = String(MAX_VARIANTS);
    swipeInput.step = '1';
    swipeInput.value = String(variantCount);
    swipeInput.addEventListener('input', () => {
      variantCount = Number(swipeInput.value);
      writeSwipeCount(variantCount);
      swipeLabel.textContent = `每轮生成　${variantCount} 段`;
    });
    swipeRow.appendChild(swipeInput);
    sec.appendChild(swipeRow);

    const sndRow = el('div', 'ne-field');
    sndRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
    sndRow.appendChild(el('span', 'ne-field-label', '音效'));
    const sndBtn = el('button', 'ne-btn', audio.isEnabled() ? '已开启' : '已关闭');
    sndBtn.type = 'button';
    sndBtn.dataset.sfx = 'confirm';
    sndBtn.addEventListener('click', () => {
      const next = !audio.isEnabled();
      audio.setEnabled(next);
      writeSoundOn(next);
      if (next) ensureAudio();
      sndBtn.textContent = next ? '已开启' : '已关闭';
    });
    sndRow.appendChild(sndBtn);
    sec.appendChild(sndRow);

    /* 背景音乐 —— 跟音效分开的独立开关 */
    const bgmRow = el('div', 'ne-field');
    bgmRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
    bgmRow.appendChild(el('span', 'ne-field-label', '背景音乐'));
    const bgmBtn = el('button', 'ne-btn', audio.isBgmEnabled() ? '已开启' : '已关闭');
    bgmBtn.type = 'button';
    bgmBtn.dataset.sfx = 'confirm';
    bgmBtn.addEventListener('click', () => {
      const next = !audio.isBgmEnabled();
      audio.setBgmEnabled(next);
      writeBgmOn(next);
      if (next && !audio.isEnabled()) {
        appendSystem('音效总开关是关着的 —— 音乐也听不到，先把音效打开', 'warn');
      }
      bgmBtn.textContent = next ? '已开启' : '已关闭';
      audio.select();
    });
    bgmRow.appendChild(bgmBtn);
    sec.appendChild(bgmRow);

    const volRow = el('div', 'ne-field');
    volRow.style.cssText = 'display:flex;align-items:center;gap:12px;';
    const volLabel = el('span', 'ne-field-label', `音量　${Math.round(readVolume() * 100)}`);
    volLabel.style.flex = 'none';
    const volInput = el('input', 'ne-range');
    volInput.type = 'range';
    volInput.min = '0';
    volInput.max = '100';
    volInput.step = '5';
    volInput.value = String(Math.round(readVolume() * 100));
    volInput.style.flex = '1';
    volInput.addEventListener('input', () => {
      const v = Number(volInput.value) / 100;
      audio.setVolume(v);
      writeVolume(v);
      volLabel.textContent = `音量　${Math.round(v * 100)}`;
    });
    // 松手才试听一声 —— 拖动过程中连响会吵
    volInput.addEventListener('change', () => { ensureAudio(); audio.bong(); });
    volRow.append(volLabel, volInput);
    sec.appendChild(volRow);

    /* 雨夜模式的专属机制开关：看模式**声明**了什么机制，不看 guards ——
       guards 在机制关掉时会被清空，用它判断的话开关自己会消失、再也打不开。 */
    if (world.rules?.consentEnforced === true) {
      const mecRow = el('div', 'ne-field');
      mecRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
      mecRow.appendChild(el('span', 'ne-field-label', '边界机制'));
      const mecBtn = el('button', 'ne-btn', readBoundary() ? '已开启' : '已关闭');
      mecBtn.type = 'button';
      mecBtn.dataset.sfx = 'toggle';
      mecBtn.title = '关掉后不再拦推进，也不再显示「当轮意愿与边界」卡 —— 只想走剧情时用';
      mecBtn.addEventListener('click', () => {
        const next = !readBoundary();
        writeBoundary(next);
        mecBtn.textContent = next ? '已开启' : '已关闭';
        appendSystem(next
          ? '边界机制已开启 —— 推进前会先看当轮意愿有没有登记'
          : '边界机制已关闭 —— 重新进入本局后生效（闸门与意愿卡一并收起）', 'warn');
      });
      mecRow.appendChild(mecBtn);
      sec.appendChild(mecRow);
      sec.appendChild(el('p', 'ne-modal-note',
        '这是「雨夜模式」自带的机制：推进前先看当轮意愿是否登记，没登记就不放行。'
        + '关掉它，故事照走，只是不再过这道闸。'));
    }

    sec.appendChild(el('p', 'ne-modal-warn',
      '密钥只存在这台机器的浏览器里。导入的预设会覆盖采样参数与系统提示词。'));

    const actions = el('div', 'ne-modal-actions');
    const btnApply = el('button', 'ne-btn ne-btn-primary', '保存');
    const btnClear = el('button', 'ne-btn', '清除模型配置');
    btnApply.type = btnClear.type = 'button';
    btnApply.dataset.sfx = 'confirm';   // 保存模型配置 = 确认
    btnClear.dataset.sfx = 'deny';      // 清掉配置是破坏性动作
    actions.append(btnClear, btnApply);
    sec.appendChild(actions);
    card.appendChild(apiFold.sec);

    /* 玩法：推进方式 / 群聊 / 玩家设定 —— 常用，默认摊开 */
    // 玩法默认折叠（用户要求）：设置里最常动的不是玩法，展开着反而把别组挤下去
    const playFold = foldSection('玩法', { key: 'play' });
    const play = playFold.body;

    const drvField = el('div', 'ne-field');
    drvField.appendChild(el('span', 'ne-field-label', '推进方式'));
    const drvRow = el('div', 'ne-modal-actions');
    drvRow.style.cssText = 'justify-content:flex-start;flex-wrap:wrap;';
    for (const [v, label, hint] of [
      ['story', '事件驱动', '引擎从事件池选事件，给你分支选项'],
      ['free', '自由对话', '你说什么就答什么，不推进事件节点（需要接模型）'],
    ]) {
      const b = el('button', `ne-btn${readChatMode() === v ? ' ne-btn-primary' : ''}`, label);
      b.type = 'button';
      b.title = hint;
      b.dataset.sfx = 'select';    // 二选一，纯选择
      b.addEventListener('click', () => {
        writeChatMode(v);
        drvRow.querySelectorAll('button').forEach(x => x.classList.toggle('ne-btn-primary', x.textContent === label));
        syncBoyButton();
        appendSystem(`推进方式已切到「${label}」${v === 'free' ? ' —— 记得接入模型' : ''}`, 'good');
      });
      drvRow.appendChild(b);
    }
    drvField.appendChild(drvRow);
    play.appendChild(drvField);
    play.appendChild(el('p', 'ne-modal-note',
      '两种方式共用同一份存档、数值与书架；区别只在「这一轮怎么产生」。'));

    /* 流式：只影响「文字怎么出现在屏幕上」，不碰存档内容。
       放在玩法里而不是小二面板里 —— 小二那套开关管的是能力，这条管的是呈现。 */
    const stmField = el('div', 'ne-field');
    stmField.appendChild(el('span', 'ne-field-label', '流式输出'));
    const stmRow = el('div', 'ne-modal-actions');
    stmRow.style.cssText = 'justify-content:flex-start;';
    const stmBtn = el('button', 'ne-btn', readStream() ? '流式输出 · 开' : '流式输出 · 关');
    stmBtn.type = 'button';
    stmBtn.title = '开着：文字边生成边显示；关掉：等整段生成完再一次显示';
    stmBtn.dataset.sfx = 'toggle';   // 开 / 关
    stmBtn.addEventListener('click', () => {
      const on = !readStream();
      writeStream(on);
      stmBtn.textContent = on ? '流式输出 · 开' : '流式输出 · 关';
      appendSystem(on ? '流式输出已开：回复会逐字显示' : '流式输出已关：等整段生成完再一次显示', 'good');
    });
    stmRow.appendChild(stmBtn);
    stmField.appendChild(stmRow);
    stmField.appendChild(el('p', 'ne-modal-note',
      '只影响自由对话的显示过程 —— 存档、分段、切换版本都不受它影响；'
      + '关掉只是少看一次逐字生成，内容一模一样。'));
    play.appendChild(stmField);

    const grpField = el('div', 'ne-field');
    grpField.appendChild(el('span', 'ne-field-label', '群聊'));
    const grpRow = el('div', 'ne-modal-actions');
    grpRow.style.cssText = 'justify-content:flex-start;';
    const grpBtn = el('button', 'ne-btn', readGroup() ? '已开启' : '已关闭');
    grpBtn.type = 'button';
    grpBtn.dataset.sfx = 'toggle';   // 开 / 关
    grpBtn.addEventListener('click', () => {
      const on = !readGroup();
      writeGroup(on);
      grpBtn.textContent = on ? '已开启' : '已关闭';
      appendSystem(on ? '群聊已开：在场角色会各自开口，按【角色名】分段' : '群聊已关：回复按整体叙述', 'good');
    });
    grpRow.appendChild(grpBtn);
    grpField.appendChild(grpRow);
    grpField.appendChild(el('p', 'ne-modal-note',
      '开启后，模型会按「【林晚晴】……」这样的分段让每个角色分别说话；不影响存档结构。'));
    play.appendChild(grpField);

    /* 谁开口 —— 做法参考酒馆的 activation_strategy */
    const spkField = el('div', 'ne-field');
    spkField.appendChild(el('span', 'ne-field-label', '这一轮谁开口'));
    const spkRow = el('div', 'ne-modal-actions');
    spkRow.style.cssText = 'justify-content:flex-start;flex-wrap:wrap;';
    for (const [v, label, hint] of [
      ['natural', '点名谁谁答', '你这句话里提到谁的名字，就让谁回应；没提到就大家随意'],
      ['list', '大家一起答', '在场角色都可以开口，由模型决定谁说'],
      ['manual', '随机一个', '每轮随机挑一个角色回应'],
    ]) {
      const b = el('button', `ne-btn${readSpeakerStrategy() === v ? ' ne-btn-primary' : ''}`, label);
      b.type = 'button';
      b.title = hint;
      b.dataset.sfx = 'select';   // 三选一策略，纯选择
      b.addEventListener('click', () => {
        writeSpeakerStrategy(v);
        spkRow.querySelectorAll('button').forEach(x => x.classList.toggle('ne-btn-primary', x.textContent === label));
        appendSystem(`谁开口：${label}`, 'good');
      });
      spkRow.appendChild(b);
    }
    spkField.appendChild(spkRow);

    const selfRow = el('div', 'ne-modal-actions');
    selfRow.style.cssText = 'justify-content:flex-start;margin-top:6px;';
    const selfBtn = el('button', 'ne-btn', readAllowSelf() ? '可以连着说：已开启' : '可以连着说：已关闭');
    selfBtn.type = 'button';
    selfBtn.title = '关闭时，上一条开口的角色这一轮不再接话（避免一个人自言自语）';
    selfBtn.dataset.sfx = 'toggle';   // 开 / 关
    selfBtn.addEventListener('click', () => {
      const on = !readAllowSelf();
      writeAllowSelf(on);
      selfBtn.textContent = on ? '可以连着说：已开启' : '可以连着说：已关闭';
    });
    selfRow.appendChild(selfBtn);
    spkField.appendChild(selfRow);
    spkField.appendChild(el('p', 'ne-modal-note',
      '默认不让同一个角色连着说两段 —— 这条是从酒馆的群聊学来的，不然容易变成自问自答。'));
    play.appendChild(spkField);

    /* 谁不开口 —— 酒馆的 disabled_members。
       人多了以后总有人不该接话（还没出场的、正在忙别的），
       又不能让他从状态里消失，所以给他们各自一个开关。 */
    const memField = el('div', 'ne-field');
    memField.appendChild(el('span', 'ne-field-label', '谁可以不开口'));
    const memWrap = el('div', 'ne-member-list');

    const renderMembers = () => {
      memWrap.innerHTML = '';
      const off = new Set(readDisabled());
      const cast = Object.entries(store.getState().actors ?? {})
        .filter(([, a]) => a.met)
        .map(([id, a]) => ({ id, name: a.name }));

      if (cast.length === 0) {
        // 空态要说清为什么空 —— 只写「还没有见过的角色」会让人以为开关坏了。
        // 在场名单本身就是「已经见过的人」，没见过的人本来也不会开口。
        memWrap.appendChild(el('p', 'ne-modal-note',
          '还没有见过任何角色。见过的角色会出现在这里，届时可以逐个关掉 —— '
          + '没见过的本来也不会开口，所以现在没什么可关的。'));
        return;
      }

      for (const a of cast) {
        const chip = el('button', `ne-member${off.has(a.id) ? ' is-off' : ''}`, a.name);
        chip.type = 'button';
        chip.title = off.has(a.id) ? '点一下让他重新开口' : '点一下让他这一轮不开口';
        chip.dataset.sfx = 'select';   // 多选成员，逐个挑
        chip.addEventListener('click', () => {
          const cur = new Set(readDisabled());
          if (cur.has(a.id)) cur.delete(a.id); else cur.add(a.id);
          writeDisabled([...cur]);
          renderMembers();
        });
        memWrap.appendChild(chip);
      }
    };
    renderMembers();
    memField.appendChild(memWrap);
    memField.appendChild(el('p', 'ne-modal-note',
      '点名字切换。被关掉的角色仍在场、数值照常，只是这一轮不让他说话。'));
    play.appendChild(memField);

    const pn = readPersona();
    const pName = el('label', 'ne-field');
    pName.appendChild(el('span', 'ne-field-label', '你（玩家）的名字'));
    const pNameInput = el('input', 'ne-field-input');
    pNameInput.type = 'text';
    pNameInput.value = pn.name;
    pNameInput.placeholder = '留空则由模型自由称呼';
    pName.appendChild(pNameInput);

    const pDesc = el('label', 'ne-field');
    pDesc.appendChild(el('span', 'ne-field-label', '你（玩家）的设定'));
    const pDescArea = el('textarea', 'ne-field-area');
    pDescArea.rows = 3;
    pDescArea.value = pn.desc;
    pDescArea.placeholder = '年龄、身份、与在场角色的关系…… 只喂给模型，不进数值系统';
    pDesc.appendChild(pDescArea);

    /* 设定放在哪 —— 参考酒馆 persona 的 position / depth / role。
       放 system 里最省事，但离当前这句太远时模型对「你是谁」的注意力会掉；
       放到末尾能把这一点拉回来。 */
    const posField = el('div', 'ne-field');
    posField.appendChild(el('span', 'ne-field-label', '设定放在哪'));
    const posRow = el('div', 'ne-modal-actions');
    posRow.style.cssText = 'justify-content:flex-start;flex-wrap:wrap;';

    const DEPTH_ROW = el('div', 'ne-modal-actions');
    DEPTH_ROW.style.cssText = 'justify-content:flex-start;margin-top:6px;align-items:center;';

    let personaPos = pn.position;

    const syncDepthRow = () => {
      DEPTH_ROW.style.display = personaPos === 'at-depth' ? '' : 'none';
    };

    for (const [v, label, hint] of [
      ['in-prompt', '系统提示里', '拼进 system —— 最省 token'],
      ['top', '放最前', '单独一条，放在对话最前面'],
      ['bottom', '放最后', '单独一条，紧贴你这句话之前'],
      ['at-depth', '指定深度', '插在距末尾若干条处 —— 越靠后，模型越在意'],
    ]) {
      const b = el('button', `ne-btn${personaPos === v ? ' ne-btn-primary' : ''}`, label);
      b.type = 'button';
      b.title = hint;
      b.dataset.sfx = 'select';   // 三选一位置，纯选择
      b.addEventListener('click', () => {
        personaPos = v;
        posRow.querySelectorAll('button').forEach(x => x.classList.toggle('ne-btn-primary', x.textContent === label));
        syncDepthRow();
      });
      posRow.appendChild(b);
    }
    posField.appendChild(posRow);

    const depthLab = el('span', 'ne-field-label', '距末尾');
    depthLab.style.margin = '0 8px 0 0';
    const depthIn = el('input', 'ne-field-input rx-mini');
    depthIn.type = 'number';
    depthIn.min = '0';
    depthIn.max = '40';
    depthIn.value = String(pn.depth);
    depthIn.style.cssText = 'width:64px;';
    const depthNote = el('span', 'ne-modal-note', '条（0 = 紧贴你这句话）');
    depthNote.style.margin = '0';
    DEPTH_ROW.append(depthLab, depthIn, depthNote);
    posField.appendChild(DEPTH_ROW);
    syncDepthRow();

    const roleRow = el('div', 'ne-modal-actions');
    roleRow.style.cssText = 'justify-content:flex-start;flex-wrap:wrap;margin-top:8px;';
    roleRow.appendChild(el('span', 'ne-field-label', '以什么身份发'));
    let personaRole = pn.role;
    for (const [v, label] of [['system', '系统'], ['user', '玩家'], ['assistant', '角色']]) {
      const b = el('button', `ne-btn${personaRole === v ? ' ne-btn-primary' : ''}`, label);
      b.type = 'button';
      b.title = v === 'user' ? '有些模型对「第一人称设定」反应更好' : '';
      b.dataset.sfx = 'select';   // 三选一身份，跟上面两组选择同一族
      b.addEventListener('click', () => {
        personaRole = v;
        roleRow.querySelectorAll('button').forEach(x => x.classList.toggle('ne-btn-primary', x.textContent === label));
      });
      roleRow.appendChild(b);
    }
    posField.appendChild(roleRow);
    play.appendChild(posField);

    const pSave = el('div', 'ne-modal-actions');
    const pSaveBtn = el('button', 'ne-btn ne-btn-primary', '保存玩家设定');
    pSaveBtn.type = 'button';
    pSaveBtn.dataset.sfx = 'confirm';   // 保存 = 确认
    pSaveBtn.addEventListener('click', () => {
      writePersona(pNameInput.value.trim(), pDescArea.value.trim());
      writePersonaExtra({
        position: personaPos,
        depth: Math.max(0, Math.min(40, Number(depthIn.value) || 0)),
        role: personaRole,
      });
      appendSystem('玩家设定已保存', 'good');
    });
    pSave.appendChild(pSaveBtn);
    play.append(pName, pDesc, pSave);
    card.appendChild(playFold.sec);

    /* 模式与数据 */
    const miscFold = foldSection('模式与数据', { key: 'misc', note: mode === 'rainnight' ? '雨夜模式' : '茶馆标准' });
    const misc = miscFold.body;

    const modeRow = el('div', 'ne-modal-actions');
    modeRow.style.cssText = 'justify-content:flex-start;flex-wrap:wrap;';
    const otherMode = mode === 'rainnight' ? 'tea' : 'rainnight';
    const btnMode = el('button', 'ne-btn',
      `切换到「${otherMode === 'rainnight' ? '雨夜模式' : '茶馆标准'}」（重载）`);
    btnMode.type = 'button';
    btnMode.dataset.sfx = 'toggle';   // 换模式重载，字面就是 toggle（不是"确认"）
    btnMode.addEventListener('click', () => {
      writeMode(otherMode);
      window.location.reload();
    });
    modeRow.appendChild(btnMode);

    const btnWipe = el('button', 'ne-btn', '清除全部本地数据');
    btnWipe.type = 'button';
    btnWipe.dataset.sfx = 'deny';     // 破坏性：删掉全部存档
    btnWipe.addEventListener('click', () => {
      try { storage?.clear(); } catch { /* 忽略 */ }
      window.location.reload();
    });
    modeRow.appendChild(btnWipe);
    misc.appendChild(modeRow);
    card.appendChild(miscFold.sec);

    overlay.appendChild(card);
    root.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    btnApply.addEventListener('click', () => {
      config = {
        endpoint: fields.endpoint.value.trim(),
        apiKey: fields.apiKey.value.trim(),
        model: fields.model.value.trim(),
      };
      writeConfig(storage, config);
      refreshModelState();
      appendSystem(client.ready() ? `已接入 ${config.model}` : '还差东西：接口地址和模型名都要填',
        client.ready() ? 'good' : 'warn');
      close();
    });

    btnClear.addEventListener('click', () => {
      config = { endpoint: '', apiKey: '', model: '' };
      clearConfig(storage);
      presetOverrides = {};
      refreshModelState();
      appendSystem('已清除模型配置，回到离线模式');
      close();
    });
  }

  function refreshModelState() {
    // 预设覆盖采样参数；接口地址与密钥仍以手动配置为准
    client = createClient({ ...config, ...presetOverrides });
    director = buildDirector();
  }

  /* ---------------------------------------------------------------- *
   * 底部：选项与输入
   * ---------------------------------------------------------------- */

  function renderChoices(opened) {
    choices.innerHTML = '';
    if (!opened?.event) {
      choices.style.display = 'none';
      return;
    }
    choices.style.display = '';

    opened.options.forEach((opt) => {
      const btn = el('button', `ne-choice${opt.available ? '' : ' is-locked'}`);
      btn.type = 'button';
      btn.dataset.sfx = 'pick';    // 推进选项 = 抽一支签，全站最典型的 pick
      btn.appendChild(el('span', 'ne-choice-key', opt.key));
      /* §13.2：选项文本按「【线名 · 推进幅度】…」呈现。
         line / magnitude 由引擎从分支 effects **推导**（src/engine.js），
         推不出就不加前缀 —— 不硬编一个假分类糊在玩家脸上。 */
      if (opt.line) {
        btn.appendChild(el('span', 'ne-choice-line', `【${opt.line} · ${opt.magnitude}】`));
      }
      btn.appendChild(el('span', null, opt.label));
      if (!opt.available) {
        btn.disabled = true;
        btn.appendChild(el('span', 'ne-choice-why', opt.reason ?? '条件不成立'));
        if (opt.reasonDetail) btn.title = opt.reasonDetail;
      } else {
        // 悬停音与点击音由全站委托层统一发（见 installUiFeedback）——
        // 这里再挂一次就会叠成两响
        btn.addEventListener('click', () => {
          ensureAudio();
          choose(opened.event, opt.key, '');
        });
      }
      choices.appendChild(btn);
    });

    /* 小二：选项已经画在屏幕上了，脚本现在读到的东西与玩家看到的一致。
       放在这里而不是 render() 里，是因为"有选项"才是脚本真正关心的时点。 */
    const st = store.getState();
    boy.emit('turn:ready', {
      turn: (st.history ?? []).length + 1,
      clock: st.clock ? { day: st.clock.day, slot: st.clock.slot } : null,
      where: st.where,
      options: opened.options.map(o => ({ key: o.key, label: o.label, available: !!o.available })),
    });
  }

  /* ---------------------------------------------------------------- *
   * 渲染总入口
   * ---------------------------------------------------------------- */

  function syncTurn() {
    const state = store.getState();
    if (state.endings.length > 0) return null;
    const opened = nextTurn(state, world);
    if (hashState(opened.state) !== hashState(state)) store.commit(opened.state);
    return opened;
  }

  function render() {
    const state = store.getState();
    rebuildStream();
    renderSidebar(buildView(state, world));
    renderLibrary();

    if (state.endings.length > 0) {
      currentTurn = null;
      renderChoices(null);
      inputRow.style.display = 'none';
      tip.style.display = 'none';
      renderEnding(state);
      scrollToEnd();
      return;
    }

    inputRow.style.display = '';
    tip.style.display = '';
    input.disabled = false;
    const opened = syncTurn();
    currentTurn = opened;
    renderChoices(opened);
    scrollToEnd();
  }

  function renderEnding(state) {
    for (const id of state.endings) {
      const def = world.endings.find(e => e.id === id);
      const box = el('div', 'ne-ending');
      box.appendChild(el('div', 'ne-ending-tag', '结 局'));
      box.appendChild(el('h2', 'ne-ending-title', def?.title ?? id));
      if (def?.note) box.appendChild(el('p', 'ne-ending-note', def.note));
      box.appendChild(el('p', 'ne-ending-stat', `共 ${state.history.length} 轮 · 线索 ${state.clues.length} 条`));

      /* §19.1.3：结局要附「达成条件回放」与「未达成项提示」——
         否则玩家只看到一句判词，不知道自己凭什么走到这里、又差在哪。
         复用引擎的 endingTrace / missedEndings（和判定同一套遍历）。 */
      if (def) {
        const { reached } = endingTrace(def, state);
        if (reached.length > 0) {
          const back = el('div', 'ne-ending-trace');
          back.appendChild(el('div', 'ne-ending-trace-head', '达成条件回顾'));
          const ul = el('div', 'ne-ending-trace-list');
          for (const it of reached) ul.appendChild(el('div', 'ne-ending-trace-item', it.note || it.path));
          back.appendChild(ul);
          box.appendChild(back);
        }
        const missed = missedEndings(world, state, def.id, 3);
        if (missed.length > 0) {
          const miss = el('div', 'ne-ending-trace ne-ending-missed');
          miss.appendChild(el('div', 'ne-ending-trace-head', '另外几条路，差在哪里'));
          const ul = el('div', 'ne-ending-trace-list');
          for (const m of missed) {
            ul.appendChild(el('div', 'ne-ending-trace-item', `${m.title} —— ${m.missing}`));
          }
          miss.appendChild(ul);
          box.appendChild(miss);
        }
      }
      stream.appendChild(box);
    }

    const again = el('button', 'ne-btn ne-btn-primary', '重新开始');
    again.type = 'button';
    again.dataset.sfx = 'toggle';     // 这不是"确认"——它把当前这一局清掉重来
    again.addEventListener('click', reset);
    const wrap = el('div', 'ne-modal-actions');
    wrap.style.justifyContent = 'center';
    wrap.appendChild(again);
    stream.appendChild(wrap);
  }

  /* ---------------------------------------------------------------- *
   * 交互
   * ---------------------------------------------------------------- */

  function setBusy(on) {
    busy = on;
    app.classList.toggle('is-busy', on);
    input.disabled = on;
    btnSend.disabled = on;
    choices.querySelectorAll('.ne-choice').forEach(b => {
      b.disabled = on || b.classList.contains('is-locked');
    });
    stream.querySelectorAll('.ne-swipe-btn').forEach(b => { b.disabled = on; });
    if (!on) refreshAllSwipeBars();
  }

  /** 忙完之后把切换条的可用状态恢复过来 */
  function refreshAllSwipeBars() {
    for (const record of store.getState().history ?? []) {
      const node = stream.querySelector(`[data-turn="${record.turn}"]`);
      if (node) updateSwipeBar(node, record);
    }
  }

  /** 生成中的正文先占位，收到增量再填 */
  function markLive() {
    const nodes = stream.querySelectorAll('.ne-msg-narrator');
    const last = nodes[nodes.length - 1];
    if (!last) return null;
    last.classList.add('ne-msg-live');
    const text = last.querySelector('.ne-msg-text');
    text.textContent = '…';
    liveTarget = { node: last, text };
    scrollToEnd();
    return liveTarget;
  }

  /**
   * 自由对话的流式占位：自己造气泡，不走 markLive()。
   *
   * markLive() 取的是「已落库、已渲染」的那条叙述消息 —— 自由对话发起时
   * 还没有这条记录，history 里最后一条是上一轮的，借用它会写错地方。
   * 这里造一个 class 与 freeNode() 同族的临时气泡，并挂上 liveTarget，
   * 让 handleDelta 有的可写。返回值交给 clearFreeLive() 拆掉。
   *
   * 不设 dataset.turn：switchVariant / refreshSwipeBar 用 [data-turn=...]
   * 定位节点，临时节点不该被它们认领。
   */
  function streamFreeLive() {
    const box = el('div', 'ne-msg ne-msg-narrator ne-msg-free ne-msg-live');
    const head = el('div', 'ne-msg-head');
    head.appendChild(el('span', 'ne-msg-kind', '自由对话'));
    box.appendChild(head);
    const text = el('p', 'ne-msg-text', '…');
    box.appendChild(text);

    stream.appendChild(box);
    liveTarget = { node: box, text };
    scrollToEnd();
    return box;
  }

  /** 拆掉流式占位气泡。落库后 render() 会按 history 重画，这一步只是清理中间态。 */
  function clearFreeLive(box) {
    if (box && box.parentNode) box.parentNode.removeChild(box);
    if (liveTarget && liveTarget.node === box) liveTarget = null;
  }

  /**
   * 把最终正文写回 history。第一个版本要同步进 variants，
   * 否则切换条上会留着预写文本，和屏幕上看到的对不上。
   */
  function persistNarration(text) {
    const state = store.getState();
    const index = (state.history ?? []).length - 1;
    if (index < 0) return;

    const record = state.history[index];
    const hasVariants = Array.isArray(record.variants) && record.variants.length > 0;

    const effects = [
      { path: `history[${index}].text`, op: 'set', value: text },
      hasVariants
        ? { path: `history[${index}].variants[0]`, op: 'set', value: text }
        : { path: `history[${index}].variants`, op: 'set', value: [text] },
      { path: `history[${index}].variantIndex`, op: 'set', value: 0 },
    ];

    const { state: next } = applyEffects(state, effects);
    store.commit(next);
  }

  /** 后台把其余版本补出来。玩家中途往下走了就停下，别往旧轮次里塞 */
  async function fillVariants(count, ctx, expectedLength) {
    for (let i = 1; i < count; i++) {
      const current = store.getState();
      if ((current.history ?? []).length !== expectedLength) return;

      const extra = await director.narrate({ ...ctx, stream: false });
      if (extra.source !== 'model' || !extra.text) continue;

      const now = store.getState();
      if ((now.history ?? []).length !== expectedLength) return;

      const turnIndex = expectedLength - 1;
      const { state: next } = applyEffects(now, [
        { path: `history[${turnIndex}].variants`, op: 'push', value: extra.text },
      ]);
      store.commit(next);
      refreshSwipeBar(turnIndex);
    }
  }

  async function choose(event, branchKey, playerInput) {
    if (busy) return;
    setBusy(true);

    try {
      const { state: after, report } = applyTurn(store.getState(), event, branchKey, world);
      store.commit(after);
      render();

      const branch = event.branches.find(b => b.key === report.branchKey);

      /* 小二：这一轮落库了。
         轮号从**落库后的 history 长度**取，不从 report 里取 ——
         report 没有轮号字段，现推一个比编一个可靠。 */
      boy.emit('turn:finished', {
        turn: (after.history ?? []).length,
        eventId: event.id,
        branchKey: report.branchKey,
        changes: (report.changes ?? []).map(c => ({ path: c.path, from: c.from, to: c.to })),
      });
      for (const a of report.achievements ?? []) {
        boy.emit('achievement:unlocked', { id: a.id, name: a.title ?? a.id });
      }
      /* report.ending 是 {id,title} 对象，不是 id 字符串 */
      if (report.ending) {
        boy.emit('ending:reached', { id: report.ending.id, name: report.ending.title ?? report.ending.id });
      }

      const notices = [];
      if (report.achievements.length > 0) {
        notices.push(`成就解锁：${report.achievements.map(a => a.title).join(' / ')}`);
      }
      // 结局有专门的结局卡，这里不重复播报

      // 雨势跟着进度走
      const level = ambientLevel();
      atmosphere.setIntensity(level);
      audio.setAmbient(level);

      if (!director.hasModel()) {
        if (report.achievements.length > 0) audio.unlock();
        if (report.ending) {
          audio.ending();
          atmosphere.pulse();
        }
        for (const n of notices) appendSystem(n, 'good');
        return;
      }

      const live = markLive();
      ensureAudio();
      audio.begins();
      const narration = await director.narrate({ state: after, event, branch, report, playerInput });
      liveTarget = null;

      if (live) {
        live.text.textContent = narration.text;
        live.node.classList.remove('ne-msg-live');
      }
      persistNarration(narration.text);
      audio.settles();

      if (report.achievements.length > 0) audio.unlock();
      if (report.ending) {
        audio.ending();
        atmosphere.pulse();
      }

      if (narration.error) {
        appendSystem(`模型没接上，这一段用预写文本：${narration.error.message}`, 'warn');
      }
      for (const n of notices) appendSystem(n, 'good');
      if (!store.getState().endings.length) scrollToEnd();

      // 其余版本后台补，补完切换条自己就亮了。不 await，玩家不用等。
      if (narration.source === 'model' && variantCount > 1) {
        fillVariants(variantCount, { state: after, event, branch, report, playerInput }, after.history.length);
      }
    } catch (e) {
      liveTarget = null;
      if (e instanceof TurnRejected) {
        appendSystem(e.message, 'warn');
        return;
      }
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function submitText() {
    const text = input.value.trim();
    if (!text || busy) return;

    // 自由对话：不选分支、不推进事件，模型直接答
    if (readChatMode() === 'free') {
      await submitFree(text);
      return;
    }

    const opened = currentTurn;
    if (!opened?.event) { appendSystem('现在没有可以推进的事了', 'warn'); return; }

    input.value = '';
    setBusy(true);

    let decision;
    try {
      decision = await director.resolveBranch(store.getState(), opened.event, opened.options, text);
    } finally {
      setBusy(false);
    }

    if (!decision.ok) {
      const suggestions = decision.intent?.suggestions ?? [];
      appendSystem(suggestions.length
        ? `没听明白。可以试试：${suggestions.join('　')}`
        : '没听明白你的意思，换种说法试试', 'warn');
      input.focus();
      return;
    }

    if (decision.source === 'model' && decision.note) {
      appendSystem(`模型理解为：${decision.note}`);
    }

    await choose(opened.event, decision.branchKey, text);
    input.focus();
  }

  /**
   * 自由对话的一轮。
   *
   * 落库形状与事件驱动一致（history 里一条记录），只是 eventId/branchKey 为 null、
   * 多一个 segments（群聊分段）。这样存档、回退、正文重建全都照旧能用 ——
   * 不用为"没走事件"再开一套。
   */
  async function submitFree(text) {
    if (!director.hasModel()) {
      appendSystem('自由对话需要先接入模型（设置里填端点与模型名）', 'warn');
      return;
    }

    input.value = '';
    setBusy(true);
    audio.begins();

    /* 流式的落点。
       不能用 markLive()：它是给「已经落库、已经渲染成叙述气泡」的那条占位用的，
       靠 querySelectorAll('.ne-msg-narrator') 取最后一个 —— 自由对话此刻还没落库，
       末尾那一条可能是上一轮的记录，接上去会把增量写进别人的气泡里。
       所以这里自己造一个临时气泡：class 与 freeNode() 保持同一族
       （ne-msg ne-msg-narrator ne-msg-free），这样它长得和最终结果一样，
       切到 render() 时视觉上不跳；再挂 ne-msg-live 复用已有的打字光标与脉冲样式。
       不设 dataset.turn —— 免得 switchVariant / refreshSwipeBar 的
       [data-turn=...] 查询命中这个还没落库的临时节点。 */
    const live = streamFreeLive();

    try {
      const st = store.getState();
      const res = await director.freeReply({
        state: st,
        playerText: text,
        persona: readPersona(),
        group: readGroup(),
        speakerStrategy: readSpeakerStrategy(),
        allowSelf: readAllowSelf(),
        disabled: readDisabled(),
        stream: readStream(),
      });

      if (res.source !== 'model') {
        appendSystem(res.error ? `模型没答上来：${res.error.message}` : '模型没答上来', 'warn');
        return;
      }

      /* 流式中间态只显示未分段的裸文本（onDelta 喂的是 cleanNarration(full)），
         群聊的 segments 要等下面 render() 才切成【角色名】分段气泡。
         这是本期接受的取舍：先看到字，再看到结构 —— 不是丢内容。 */
      const entry = {
        turn: (st.history ?? []).length + 1,
        eventId: null,
        branchKey: null,
        mode: 'free',
        text: res.text,
        variants: [res.text],
        variantIndex: 0,
        segments: res.segments,
        said: text,
        day: st.clock.day,
        slot: st.clock.slot,
        where: st.where,
        changes: [],
      };

      const after = applyEffects(st, [{ path: 'history', op: 'push', value: entry }]).state;
      store.commit(after);
      render();
      audio.settles();

      /* 小二：自由对话这一轮的两条都广播出去。
         顺序是"玩家先、模型后"，与真人看到的一致。 */
      boy.emit('free:submitted', { turn: entry.turn, text });
      boy.emit('free:replied', { turn: entry.turn, text: res.text, segments: res.segments });
    } catch (e) {
      appendSystem(`自由对话出错：${e.message}`, 'warn');
    } finally {
      /* 无论走哪条分支都要收掉占位气泡。
         freeReply 失败时返回 { source:'none', error } 而不抛异常，
         靠 catch 兜不住 —— 必须放 finally，否则屏幕上永远留一个 '…'。 */
      clearFreeLive(live);
      setBusy(false);
      input.focus();
    }
  }

  inputRow.addEventListener('submit', (e) => {
    e.preventDefault();
    submitText();
  });

  /* ---------------------------------------------------------------- *
   * 面板开关
   * ---------------------------------------------------------------- */

  function toggle(drawer, cls, btn) {
    const on = body.classList.toggle(cls);
    btn.classList.toggle('is-active', on);
    return on;
  }

  btnSide.addEventListener('click', () => toggle(drawerLeft, 'has-left', btnSide));
  btnBoy.addEventListener('click', openBoy);
  btnGear.addEventListener('click', () => {
    openSettingsModal();
  });

  /* ---------------------------------------------------------------- *
   * 导入：世界书与角色卡
   * ---------------------------------------------------------------- */

  function applyWorldbookImport(entries, name) {
    const existing = world.book?.entries ?? [];
    // 重新过一次校验：非法条目在这里就得炸，不能等到扫描时才出怪事
    world.book = createWorldbook([...existing, ...entries]);
    return `已导入世界书${name ? `「${name}」` : ''}：${entries.length} 条`;
  }

  function applyCharacterImport(result) {
    const { actor, book } = result;
    if (!actor) throw new Error('角色卡里没有角色信息');

    /* id 撞了不中断导入：自动加序号。
       撞 id 是常见事（内置角色的 id 是 seeker/kin/lost/collector，
       导入一份自己的卡很容易撞上），为此把整次导入打回去没必要。 */
    let finalId = actor.id;
    let renamed = false;
    for (let n = 2; store.getState().actors[finalId]; n += 1) {
      finalId = `${actor.id}_${n}`;
      renamed = true;
    }

    world.actorLabels = { ...(world.actorLabels ?? {}), [finalId]: actor.name };
    world.statLabels = {
      ...(world.statLabels ?? {}),
      [finalId]: Object.fromEntries(actor.stats.map(s => [s.key, s.label ?? s.key])),
    };

    let bookNote = '';
    if (book.length > 0) {
      applyWorldbookImport(book, `${actor.name} 的内嵌设定`);
      bookNote = `，带出设定 ${book.length} 条`;
    }

    const next = structuredClone(store.getState());
    next.actors[finalId] = {
      id: finalId,
      name: actor.name,
      met: false,
      adult: actor.adult !== false,
      stats: Object.fromEntries(actor.stats.map(s => [s.key, s.init ?? 50])),
      bounds: Object.fromEntries(actor.stats.map(s => [s.key, { min: s.min ?? 0, max: s.max ?? 100 }])),
    };
    store.commit(next);

    const idNote = renamed ? `（id「${actor.id}」已有，改用「${finalId}」）` : '';
    return `已导入角色「${actor.name}」${idNote}${bookNote}`;
  }

  /** 预设：覆盖采样参数，系统提示词交给 director 拼接 */
  function applyPresetImport(result) {
    presetOverrides = {};
    const s = result.settings ?? {};
    if (s.temperature !== undefined) presetOverrides.temperature = s.temperature;
    if (s.topP !== undefined) presetOverrides.topP = s.topP;
    if (s.maxTokens !== undefined) presetOverrides.maxTokens = s.maxTokens;

    presetSystemPrompt = result.systemPrompt ?? '';
    world.presetSystemPrompt = presetSystemPrompt;

    refreshModelState();
    return `已导入预设${result.name ? `「${result.name}」` : ''}${result.systemPrompt ? '（含系统提示词）' : ''}`;
  }

  function openImport() {
    const overlay = el('div', 'ne-modal');
    const card = el('div', 'ne-modal-card');

    card.appendChild(el('h2', 'ne-modal-title', '导入'));

    /* 三个分区：世界书 / 角色卡 / 预设。分类决定"这次想导入什么"，类型不符会明说 */
    const IMPORT_TABS = [
      { label: '世界书', kind: KIND.WORLDBOOK, icon: 'world', sub: '酒馆世界书 JSON' },
      { label: '角色卡', kind: KIND.CHARACTER, icon: 'users', sub: 'V1 / V2 JSON 或 PNG' },
      { label: '模式（预设）', kind: KIND.PRESET, icon: 'settings', sub: '采样参数 + 系统提示' },
    ];
    let importTab = IMPORT_TABS[0];
    let lastFile = null;      // 记住选过的文件：换分类时要拿它重新判定一次

    /**
     * 换分类之后把下面那个框重新算一遍。
     *
     * 原先切分类只把按钮的高亮换掉，框里还留着上一个分类的解析结果 ——
     * 于是"点分类没反应"。内容的判定本来就取决于当前分类
     * （`importAs` 会对比期望分类），所以换分类必须重算，不是清空。
     */
    async function refreshPreview() {
      const text = paste.value.trim();
      if (text) {
        try {
          describe(importAs(JSON.parse(text), importTab.kind, importTab.label));
        } catch (e) {
          describe({ kind: KIND.UNKNOWN, warnings: [`不是合法的 JSON：${e.message}`] });
        }
        return;
      }
      if (lastFile) {
        describe(await parseImportFile(lastFile, importTab));
        return;
      }
      describe(null);
    }

    const catRow = el('div', 'ne-import-cats');
    const catBtns = [];
    for (const t of IMPORT_TABS) {
      const b = el('button', `import-cat${t === importTab ? ' is-on' : ''}`);
      b.type = 'button';
      b.dataset.sfx = 'select';
      b.appendChild(el('i', `ic ic-${t.icon}`));
      b.appendChild(el('span', 'import-cat-title', t.label));
      b.appendChild(el('span', 'import-cat-sub', t.sub));
      b.addEventListener('click', () => {
        importTab = t;
        catBtns.forEach(x => x.classList.toggle('is-on', x === b));
        refreshPreview();     // 换分类 → 下面的框跟着重算
      });
      catBtns.push(b);
      catRow.appendChild(b);
    }
    card.appendChild(catRow);
    card.appendChild(el('p', 'ne-modal-note',
      '粘贴或选文件后自动解析；与所选分类不符会如实提示，不会导错类。'));

    const fileRow = el('label', 'ne-field');
    fileRow.appendChild(el('span', 'ne-field-label', '选择文件'));
    const fileInput = el('input', 'ne-field-input');
    fileInput.type = 'file';
    fileInput.accept = '.json,.png,application/json,image/png';
    fileRow.appendChild(fileInput);
    card.appendChild(fileRow);

    const pasteRow = el('label', 'ne-field');
    pasteRow.appendChild(el('span', 'ne-field-label', '或者直接粘 JSON'));
    const paste = el('textarea', 'ne-field-area');
    paste.rows = 5;
    paste.placeholder = '{ "entries": { … } }   或   { "spec": "chara_card_v2", … }';
    pasteRow.appendChild(paste);
    card.appendChild(pasteRow);

    const preview = el('div', 'ne-import-preview');
    card.appendChild(preview);

    const actions = el('div', 'ne-modal-actions');
    const btnApply = el('button', 'ne-btn ne-btn-primary', '导入');
    const btnClose = el('button', 'ne-btn', '关闭');
    btnApply.type = btnClose.type = 'button';
    btnApply.dataset.sfx = 'dropped';   // 把东西"放下"进引擎，正好是 dropped 的语义
    btnClose.dataset.sfx = 'closePanel';
    actions.append(btnClose, btnApply);
    card.appendChild(actions);

    overlay.appendChild(card);
    root.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    let pending = null;

    /**
     * 三个分区各自的解析结果，**用三种不同的呈现方式**。
     *
     * 为什么不能都用 `ne-import-line` 那一串同样的段落：
     * 三份内容的**形状本来就不同**，用同一种版式等于把差异抹掉。
     *
     *   · 世界书是一张**条目账**：多条、有键、有触发方式、有是否启用
     *     → 该给"计数 + 前几条预览"，让人一眼看出"这一包有多大、什么路数"
     *   · 角色卡是**一个人**：一个名字、一段自我介绍、几句开场白、一盘数值
     *     → 该给"名片"，名字当头，其余围着它排
     *   · 预设是**一组参数**：采样三件套 + 一段系统提示词
     *     → 该给"参数表"，左右对齐，一眼看清改了什么
     *
     * 三种版式也顺带承担一个作用：**不看标题光看样式就知道自己在导什么**。
     */
    function describe(result) {
      preview.innerHTML = '';
      preview.className = 'ne-import-preview';
      pending = null;

      if (!result || result.kind === KIND.UNKNOWN) {
        for (const w of result?.warnings ?? ['还没读到内容']) {
          preview.appendChild(el('p', 'ne-modal-warn', w));
        }
        return;
      }

      /* 分区语义：目标分类与文件类型不符时明说，不悄悄导成别的东西 */
      if (result.kind !== importTab.kind) {
        const gotName = { worldbook: '世界书', character: '角色卡', preset: '预设', unknown: '未知内容' }[result.kind] ?? result.kind;
        preview.appendChild(el('p', 'ne-modal-warn',
          `当前分类是「${importTab.label}」，但这份内容是「${gotName}」—— 切到对应分类再导入`));
        return;
      }

      if (result.kind === KIND.WORLDBOOK) {
        describeWorldbook(result);
      } else if (result.kind === KIND.CHARACTER) {
        describeCharacter(result);
      } else {
        describePreset(result);
      }

      for (const w of result.warnings) preview.appendChild(el('p', 'ne-modal-warn', w));
      pending = result;
    }

    /* ── 版式一：世界书 —— 条目账 ───────────────────────────────── */

    function describeWorldbook(result) {
      preview.classList.add('is-worldbook');
      const entries = result.entries ?? [];

      /* 启用 / 停用分开数：一份世界书里常有大量停用条目，
         只报总数会让人以为"导进来一堆要用的东西" */
      const off = entries.filter(e => e.disable === true || e.enabled === false).length;
      const on = entries.length - off;

      const head = el('div', 'imp-head');
      head.appendChild(el('span', 'imp-count', String(entries.length)));
      const unit = el('div', 'imp-unit');
      unit.appendChild(el('span', 'imp-unit-main', '条目'));
      unit.appendChild(el('span', 'imp-unit-sub',
        off > 0 ? `启用 ${on} · 停用 ${off}` : '全部启用'));
      head.appendChild(unit);
      if (result.meta?.name) head.appendChild(el('span', 'imp-badge', result.meta.name));
      if (result.meta?.tokenBudget) head.appendChild(el('span', 'imp-badge is-dim', `${result.meta.tokenBudget} tokens`));
      preview.appendChild(head);

      /* 前几条：让人认出"这是哪一包"，而不是只看到一个数字 */
      const sample = entries.filter(e => e.disable !== true).slice(0, 4);
      if (sample.length) {
        const list = el('div', 'imp-entries');
        for (const e of sample) {
          const row = el('div', 'imp-entry');
          const keys = [e.key, e.keysecondary].flat().filter(Boolean).slice(0, 3);
          row.appendChild(el('span', 'imp-entry-key', keys.length ? keys.join(' / ') : '（无关键词）'));
          row.appendChild(el('span', 'imp-entry-order', `#${e.order ?? 0}`));
          list.appendChild(row);
        }
        if (entries.length > sample.length) {
          list.appendChild(el('div', 'imp-entry is-more', `还有 ${entries.length - sample.length} 条…`));
        }
        preview.appendChild(list);
      }
    }

    /* ── 版式二：角色卡 —— 名片 ─────────────────────────────────── */

    function describeCharacter(result) {
      preview.classList.add('is-character');
      const name = result.actor?.name ?? '未命名';

      /* 名片：首字当头，名字与规格并排 —— 一眼看出"这是谁" */
      const card = el('div', 'imp-idcard');
      card.appendChild(el('span', 'imp-avatar', name.slice(0, 1)));
      const who = el('div', 'imp-who');
      who.appendChild(el('span', 'imp-name', name));
      who.appendChild(el('span', 'imp-spec', result.spec ?? '未知规格'));
      card.appendChild(who);
      preview.appendChild(card);

      /* 数值盘：角色卡自带的那几项（信任 / 情绪 / 戒备），
         横向铺开 —— 这是导入后玩家最常改的东西 */
      const stats = result.actor?.stats ?? {};
      const keys = Object.keys(stats);
      if (keys.length) {
        const tray = el('div', 'imp-stats');
        for (const k of keys) {
          const cell = el('div', 'imp-stat');
          cell.appendChild(el('span', 'imp-stat-label', k));
          cell.appendChild(el('span', 'imp-stat-val', String(stats[k])));
          tray.appendChild(cell);
        }
        preview.appendChild(tray);
      }

      /* 带过来的附属物：开场白 / 内嵌设定 / 标签，用小块标出来 */
      const marks = [];
      if (result.greetings.length > 0) marks.push(['开场白', `${result.greetings.length} 条`]);
      if (result.book.length > 0) marks.push(['内嵌设定', `${result.book.length} 条`]);
      if (result.meta?.tags?.length) marks.push(['标签', result.meta.tags.join('、')]);
      if (marks.length) {
        const strip = el('div', 'imp-marks');
        for (const [k, v] of marks) {
          const m = el('div', 'imp-mark');
          m.appendChild(el('span', 'imp-mark-k', k));
          m.appendChild(el('span', 'imp-mark-v', v));
          strip.appendChild(m);
        }
        preview.appendChild(strip);
      }

      /* 开场白正文：如果有，露第一句 —— 这是"这张卡什么味道"的最快证据 */
      const first = result.greetings?.[0];
      if (first) {
        const quote = el('blockquote', 'imp-quote', first.length > 120 ? `${first.slice(0, 120)}…` : first);
        preview.appendChild(quote);
      }
    }

    /* ── 版式三：预设 —— 参数表 ─────────────────────────────────── */

    function describePreset(result) {
      preview.classList.add('is-preset');
      const s = result.settings ?? {};

      const head = el('div', 'imp-head');
      head.appendChild(el('span', 'imp-unit-main', result.name ?? '未命名预设'));
      preview.appendChild(head);

      /* 三件套固定三行、左右对齐 —— 参数就该这么看；
         没给的行不显示（而不是显示"未设置"，那会让人以为被改成了空） */
      const rows = [
        ['温度 temperature', s.temperature],
        ['top_p', s.topP],
        ['max_tokens', s.maxTokens],
      ].filter(([, v]) => v !== undefined);

      if (rows.length) {
        const table = el('div', 'imp-params');
        for (const [k, v] of rows) {
          const row = el('div', 'imp-param');
          row.appendChild(el('span', 'imp-param-k', k));
          row.appendChild(el('span', 'imp-param-v', String(v)));
          table.appendChild(row);
        }
        preview.appendChild(table);
      } else {
        preview.appendChild(el('p', 'imp-note', '这份预设没带采样参数 —— 导入只会覆盖系统提示词。'));
      }

      if (result.systemPrompt) {
        const prompt = el('div', 'imp-prompt');
        prompt.appendChild(el('span', 'imp-prompt-k', '系统提示词'));
        prompt.appendChild(el('div', 'imp-prompt-v',
          result.systemPrompt.length > 160 ? `${result.systemPrompt.slice(0, 160)}…` : result.systemPrompt));
        preview.appendChild(prompt);
      }
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      lastFile = file;
      describe(await parseImportFile(file, importTab));
    });

    enableDrop(preview, async (file) => {
      lastFile = file;
      describe(await parseImportFile(file, importTab));
    });

    paste.addEventListener('input', () => {
      const text = paste.value.trim();
      if (!text) { describe(null); return; }
      try {
        describe(importAs(JSON.parse(text), importTab.kind, importTab.label));
      } catch (e) {
        describe({ kind: KIND.UNKNOWN, warnings: [`不是合法的 JSON：${e.message}`] });
      }
    });

    btnApply.addEventListener('click', () => {
      if (!pending) {
        preview.appendChild(el('p', 'ne-modal-warn', '还没有可导入的内容'));
        return;
      }
      try {
        const message = pending.kind === KIND.CHARACTER
          ? applyCharacterImport(pending)
          : pending.kind === KIND.PRESET
            ? applyPresetImport(pending)
            : applyWorldbookImport(pending.entries, pending.meta?.name);
        close();
        render();
        appendSystem(message, 'good');
      } catch (e) {
        preview.appendChild(el('p', 'ne-modal-warn', e.message));
      }
    });

    btnClose.addEventListener('click', close);
  }

  /* ---------------------------------------------------------------- *
   * 茶馆小二 —— 自由模式下开给玩家脚本的那扇门
   *
   * 只在「自由对话」下出现：事件驱动模式下正文是引擎写的，脚本没有可读的东西。
   *
   * 三个开关一级比一级紧（总开关 → 读写档 → 硬约束），默认全关。
   * 这个面板**不提供"允许任意 JS" 的选项** —— 桥本身有清单（src/boy.js），
   * 脚本拿不到宿主 window / document，所以这里管的是"给多少"，不是"防不防"。
   * ---------------------------------------------------------------- */

  /** 示例脚本：一份能立刻看出"桥确实是通的"的最小 LOOSE-END 演示 */
  const BOY_SAMPLE = `<!-- 茶馆小二示例：读引擎真值 + 画一张卡 + 被允许时改一个值 -->
<div id="panel">
  <div class="row"><span>第</span><b id="day">—</b><span>天</span>
    <span id="slot" class="dim"></span><span id="where" class="dim"></span></div>
  <div id="stats"></div>
</div>
<div id="log" class="dim"></div>

<script>
teahouse.on('ready', async function () {
  var snap = await teahouse.read.snapshot();
  document.getElementById('day').textContent = snap.turn;
  document.getElementById('slot').textContent = snap.slotLabel || '';
  document.getElementById('where').textContent = snap.whereLabel || '';

  /* 画数值条：分母从 bounds 里取，不猜 */
  var box = document.getElementById('stats');
  (snap.actors || []).forEach(function (a) {
    Object.keys(a.stats || {}).forEach(function (k) {
      var v = a.stats[k];
      var b = (a.bounds || {})[k] || { min: 0, max: 100 };
      var pct = Math.max(0, Math.min(100, (v - b.min) / (b.max - b.min) * 100));
      var row = document.createElement('div');
      row.className = 'stat';
      row.innerHTML = '<span class="nm"></span><span class="bar"><i></i></span><b class="vv"></b>';
      row.querySelector('.nm').textContent = a.name + '·' + k;
      row.querySelector('i').style.width = pct.toFixed(1) + '%';
      row.querySelector('.vv').textContent = v;
      box.appendChild(row);
    });
  });
});

/* 引擎推来时挂一条 */
teahouse.on('turn:finished', function (p) {
  document.getElementById('log').textContent =
    '第 ' + p.turn + ' 轮已落库，改了 ' + ((p.changes || []).length) + ' 处';
});

/* 可写档 + 硬约束关掉时，才能往 flags 里记东西。
   锁着的话这里会抛，错误会显示在帧底部的红框里 —— 那正是我们想要的效果。 */
window.markSeen = async function (key) {
  try {
    await teahouse.write.set('flags.' + key, true);
    return '已记下 ' + key;
  } catch (e) {
    return '记不了：' + e.message;
  }
};
<\/script>

<style>
  #panel { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: baseline; gap: 5px; font-size: 12px;
         color: rgba(200, 215, 235, .75); }
  .row b { font-size: 15px; color: #9fd0ff; font-variant-numeric: tabular-nums; }
  .dim { color: rgba(200, 215, 235, .5); }
  .stat { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 12px; }
  .stat .nm { flex: 0 0 auto; color: rgba(210, 224, 242, .8); }
  .stat .bar { flex: 1 1 auto; height: 5px; border-radius: 3px;
               background: rgba(255, 255, 255, .1); overflow: hidden; }
  .stat .bar i { display: block; height: 100%; border-radius: 3px;
                 background: linear-gradient(90deg, #4f9eff, #7bd4ff); }
  .stat .vv { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: #cfe4ff; }
  #log { margin-top: 6px; font-size: 11.5px; }
</style>
`;

  function openBoy() {
    const cfg = readBoyConfig();
    const overlay = el('div', 'ne-modal');
    const card = el('div', 'ne-modal-card');
    card.appendChild(el('h2', 'ne-modal-title', '茶馆小二'));
    card.appendChild(el('p', 'ne-modal-note',
      '自由对话模式下，可以让你自己写的脚本读引擎状态、画自己的界面；'
      + '打开写通道后它也能改数值 —— 但仍然走引擎的写入通道，留痕与夹紧照常。'));

    /* ---- 三个开关 ---- */
    const sw = el('div', 'ne-boy-switches');

    const rowMain = el('div', 'ne-boy-sw');
    const btnMain = el('button', `ne-btn${cfg.enabled ? ' ne-btn-primary' : ''}`, cfg.enabled ? '已开启' : '已关闭');
    btnMain.type = 'button';
    btnMain.dataset.sfx = 'toggle';
    rowMain.appendChild(el('span', 'ne-boy-sw-label', '小二'));
    rowMain.appendChild(btnMain);
    sw.appendChild(rowMain);

    const rowMode = el('div', 'ne-boy-sw');
    const modeRow = el('div', 'ne-modal-actions');
    modeRow.style.cssText = 'justify-content:flex-start;gap:6px;';
    const btnRead = el('button', `ne-btn${cfg.mode === 'readonly' ? ' ne-btn-primary' : ''}`, '只读');
    const btnWrite = el('button', `ne-btn${cfg.mode === 'write' ? ' ne-btn-primary' : ''}`, '可写');
    btnRead.type = btnWrite.type = 'button';
    btnRead.dataset.sfx = btnWrite.dataset.sfx = 'select';
    modeRow.append(btnRead, btnWrite);
    rowMode.appendChild(el('span', 'ne-boy-sw-label', '读写档'));
    rowMode.appendChild(modeRow);
    sw.appendChild(rowMode);

    const rowStrict = el('div', 'ne-boy-sw');
    const btnStrict = el('button', 'ne-btn', cfg.strict ? '硬约束 · 开' : '硬约束 · 关');
    btnStrict.type = 'button';
    btnStrict.dataset.sfx = 'toggle';
    rowStrict.appendChild(el('span', 'ne-boy-sw-label', '硬约束'));
    rowStrict.appendChild(btnStrict);
    sw.appendChild(rowStrict);

    const why = el('p', 'ne-boy-why');
    sw.appendChild(why);
    card.appendChild(sw);

    /** 开关改了之后同步给桥、刷新按钮与说明。**只有这套开关决定能力，没有第二处。 */
    function syncFromConfig() {
      const c = boy.setConfig(cfg);
      writeBoyConfig(c);
      btnMain.textContent = c.enabled ? '已开启' : '已关闭';
      btnMain.classList.toggle('ne-btn-primary', c.enabled);
      btnRead.classList.toggle('ne-btn-primary', c.mode === 'readonly');
      btnWrite.classList.toggle('ne-btn-primary', c.mode === 'write');
      btnStrict.textContent = c.strict ? '硬约束 · 开' : '硬约束 · 关';
      btnStrict.classList.toggle('ne-btn-primary', c.strict);
      btnWrite.disabled = !c.enabled;
      btnStrict.disabled = !c.enabled || c.mode !== 'write';
      why.textContent = !c.enabled
        ? '关着的时候脚本不加载，它拿不到任何东西。'
        : c.mode === 'readonly'
          ? '只读：脚本能读状态、能订阅事件、能在自己那块画东西。写通道不存在。'
          : c.strict
            ? '可写 + 硬约束：只能改写已声明的路径（数值 / 线索 / 地点），且值必须是字面量。'
            : '可写 + 硬约束关：脚本还能往 flags 里塞任意值。存档里会多出脚本写的东西。';
      // 列表跟着刷一次：开关改了之后选中态可能要跟着变（关着时整片灰掉）
      renderScriptList();
      mountFrame();
    }

    btnMain.addEventListener('click', () => { cfg.enabled = !cfg.enabled; syncFromConfig(); });
    btnRead.addEventListener('click', () => { cfg.mode = 'readonly'; syncFromConfig(); });
    btnWrite.addEventListener('click', () => { cfg.mode = 'write'; syncFromConfig(); });
    btnStrict.addEventListener('click', () => { cfg.strict = !cfg.strict; syncFromConfig(); });

    /* ---- 脚本列表 ---- *
     * 从"一条脚本"变成"一列表"。列表只决定**跑哪份代码**，
     * 不影响能力判定 —— 能力仍然只由上面那三个开关决定。 */
    const listField = el('div', 'ne-field');
    listField.appendChild(el('span', 'ne-field-label', '你的脚本'));
    const scriptList = el('div', 'ne-boy-scripts');
    listField.appendChild(scriptList);

    const listTools = el('div', 'ne-modal-actions');
    listTools.style.cssText = 'justify-content:flex-start;flex-wrap:wrap;gap:6px;margin-top:6px;';
    const btnNew = el('button', 'ne-btn', '新建');
    btnNew.type = 'button';
    btnNew.dataset.sfx = 'select';
    listTools.appendChild(btnNew);
    listField.appendChild(listTools);
    card.appendChild(listField);

    /* ---- 脚本编辑 ---- */
    const scriptField = el('label', 'ne-field');
    scriptField.appendChild(el('span', 'ne-field-label', '脚本内容（HTML，可含 <script>）'));
    const ta = el('textarea', 'ne-field-area ne-boy-code');
    ta.rows = 12;
    ta.spellcheck = false;
    ta.placeholder = '写 HTML；用 window.teahouse 读写引擎。';

    let saveTimer = null;
    ta.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const cur = activeScript();
        if (!cur) return;
        const list = readBoyScripts();
        const hit = list.find(s => s.id === cur.id);
        if (!hit) return;
        hit.text = ta.value;
        writeBoyScripts(list);
        mountFrame();
      }, 600);
    });
    scriptField.appendChild(ta);

    const tools = el('div', 'ne-modal-actions');
    tools.style.cssText = 'justify-content:flex-start;flex-wrap:wrap;gap:6px;margin-top:8px;';
    const btnSample = el('button', 'ne-btn', '放回示例');
    const btnClear = el('button', 'ne-btn', '清空');
    const btnReload = el('button', 'ne-btn', '重新加载');
    btnSample.type = btnClear.type = btnReload.type = 'button';
    btnSample.dataset.sfx = btnReload.dataset.sfx = 'select';
    btnClear.dataset.sfx = 'dropped';
    btnSample.addEventListener('click', () => {
      ta.value = BOY_SAMPLE;
      saveActiveText(BOY_SAMPLE);
      mountFrame();
    });
    btnClear.addEventListener('click', () => {
      ta.value = '';
      saveActiveText('');
      mountFrame();
    });
    btnReload.addEventListener('click', () => {
      saveActiveText(ta.value);
      mountFrame();
    });
    tools.append(btnSample, btnReload, btnClear);
    scriptField.appendChild(tools);
    card.appendChild(scriptField);

    /**
     * 把文本写回当前活动脚本并持久化。
     *
     * **没有活动脚本时先建一个**（而不是静默返回）—— 玩家在空面板里打了字，
     * 结果什么都没存下来，这种丢失是查不出来的：不报错、不提示，下次打开是空的。
     * 宁可替他建一份，也别让键盘上的工夫白费。
     */
    function saveActiveText(text) {
      let cur = activeScript();
      if (!cur) {
        const list = readBoyScripts();
        cur = { id: newScriptId(list), name: '我的脚本', text: '' };
        list.push(cur);
        writeBoyScripts(list);
        writeActiveScriptId(cur.id);
        renderScriptList();
      }
      const list = readBoyScripts();
      const hit = list.find(s => s.id === cur.id);
      if (!hit) return;
      hit.text = String(text ?? '');
      writeBoyScripts(list);
    }

    /** 切到某条脚本：存下活动 id、回填编辑区、重启帧。 */
    function selectScript(id) {
      writeActiveScriptId(id);
      const cur = activeScript();
      ta.value = cur ? cur.text : '';
      renderScriptList();
      mountFrame();
    }

    /** 重命名。空名字不接受 —— 那样列表里会出现一条点不中的空行。 */
    function renameScript(id, name) {
      const trimmed = String(name ?? '').trim();
      if (!trimmed) return false;
      const list = readBoyScripts();
      const hit = list.find(s => s.id === id);
      if (!hit) return false;
      hit.name = trimmed;
      writeBoyScripts(list);
      renderScriptList();
      return true;
    }

    /**
     * 删一条。**活动脚本被删时，活动位置落到列表第一条**（按列表顺序取，
     * 不是"相邻那条"—— 相邻的语义在删首条/末条时会变得难以预料）。
     * 删光了就把活动 id 清掉，编辑区回填示例、帧显示"小二关着"。
     */
    function deleteScript(id) {
      const list = readBoyScripts().filter(s => s.id !== id);
      writeBoyScripts(list);
      const wasActive = readActiveScriptId() === id;
      if (wasActive) {
        writeActiveScriptId(list.length > 0 ? list[0].id : null);
      }
      const cur = activeScript();
      ta.value = cur ? cur.text : '';
      renderScriptList();
      mountFrame();
    }

    /** 列表的局部重画。与 syncFromConfig / mountFrame / refreshLog 并列。 */
    function renderScriptList() {
      scriptList.innerHTML = '';
      const list = readBoyScripts();
      const curId = activeScript()?.id ?? null;

      if (list.length === 0) {
        scriptList.appendChild(el('p', 'ne-modal-note',
          '还没有脚本。点「新建」写一份，或者直接在上面那块里写。'));
        return;
      }

      for (const s of list) {
        const row = el('div', 'ne-boy-script-row');
        row.classList.toggle('is-active', s.id === curId);

        const pick = el('button', 'ne-boy-script-pick', s.name);
        pick.type = 'button';
        pick.dataset.sfx = 'select';
        pick.title = `跑这一份：${s.name}`;
        pick.addEventListener('click', () => {
          if (s.id === curId) return;
          selectScript(s.id);
        });
        row.appendChild(pick);

        const btnRename = el('button', 'ne-btn ne-boy-script-mini', '改名');
        btnRename.type = 'button';
        btnRename.dataset.sfx = 'select';
        btnRename.addEventListener('click', (ev) => {
          ev.stopPropagation();
          // 就地展开输入行，不跳窗 —— 与条目编辑同一个哲学
          if (row.querySelector('.ne-boy-script-rename')) return;
          const box = el('div', 'ne-boy-script-rename');
          const inp = el('input', 'ne-boy-script-input');
          inp.type = 'text';
          inp.value = s.name;
          const ok = el('button', 'ne-btn ne-boy-script-mini', '存');
          const no = el('button', 'ne-btn ne-boy-script-mini', '算了');
          ok.type = no.type = 'button';
          ok.dataset.sfx = 'confirm';
          no.dataset.sfx = 'back';
          const commit = () => {
            if (renameScript(s.id, inp.value)) {
              appendSystem(`脚本已改名为「${inp.value.trim()}」`, 'info');
            } else {
              appendSystem('名字不能是空的', 'warn');
            }
          };
          ok.addEventListener('click', commit);
          inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
          no.addEventListener('click', () => box.remove());
          box.append(inp, ok, no);
          row.appendChild(box);
          inp.focus();
          inp.select();
        });
        row.appendChild(btnRename);

        const del = el('button', 'ne-btn ne-boy-script-mini', '删除');
        del.type = 'button';
        del.dataset.sfx = 'deny';
        del.title = `删掉这份：${s.name}`;
        /* 两段式：脚本是手写的代码，删了没处恢复，值得破一次"立即执行"的惯例。
           第一次点变成确认，4 秒没跟就自己复位。 */
        let armed = false;
        let armTimer = null;
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (!armed) {
            armed = true;
            del.textContent = '确认删除';
            del.classList.add('is-armed');
            armTimer = setTimeout(() => {
              armed = false;
              del.textContent = '删除';
              del.classList.remove('is-armed');
            }, 4000);
            return;
          }
          clearTimeout(armTimer);
          deleteScript(s.id);
          appendSystem(`已删除脚本「${s.name}」`, 'warn');
        });
        row.appendChild(del);

        scriptList.appendChild(row);
      }
    }

    btnNew.addEventListener('click', () => {
      const list = readBoyScripts();
      const fresh = { id: newScriptId(list), name: `脚本 ${list.length + 1}`, text: '' };
      list.push(fresh);
      writeBoyScripts(list);
      writeActiveScriptId(fresh.id);
      ta.value = '';
      renderScriptList();
      mountFrame();
      appendSystem('新建了一份空脚本。想从示例改起，点「放回示例」。', 'info');
    });

    /* ---- iframe 宿主 ---- */
    const frameWrap = el('div', 'ne-boy-frame');
    const frameHint = el('p', 'ne-modal-note',
      '下面是脚本真实的运行处。它拿不到茶馆的界面，只能在自己这块里画。');
    card.appendChild(frameHint);
    card.appendChild(frameWrap);

    const logBox = el('div', 'ne-boy-log');
    card.appendChild(logBox);

    /** 构造 / 重建 iframe。
     *  用 blob URL 而不是 srcdoc：脚本里要能 `<script src>` 引外部模块，
     *  srcdoc 下相对路径会解析到宿主、且 import 会因 opaque origin 失败。
     *  blob 是本地对象，不产生任何外部请求，单文件产物性质不变。 */
    let blobUrl = null;
    function mountFrame() {
      frameWrap.innerHTML = '';
      boy.detach();
      boyFrameHolder.el = null;
      if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch { /* 忽略 */ } blobUrl = null; }

      if (!cfg.enabled) {
        frameWrap.appendChild(el('p', 'ne-boy-off', '小二关着。打开上面的开关，脚本才开始跑。'));
        return;
      }

      const cur = activeScript();
      const doc = buildBoyDocument(cur ? cur.text : '');
      blobUrl = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
      const f = document.createElement('iframe');
      f.className = 'ne-boy-iframe';
      f.setAttribute('sandbox', 'allow-scripts');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.src = blobUrl;
      f.addEventListener('load', () => {
        boy.attach(f);
        boyFrameHolder.el = f;
        refreshLog();
      });
      frameWrap.appendChild(f);
    }

    function refreshLog() {
      const lines = boy.log.slice(-6);
      logBox.innerHTML = '';
      if (!lines.length) {
        logBox.appendChild(el('p', 'ne-modal-note', '脚本还没有写过东西。'));
        return;
      }
      for (const l of lines) {
        logBox.appendChild(el('p', `ne-boy-logline ${l.ok ? 'is-ok' : 'is-no'}`,
          `${l.ok ? '✓' : '✕'} ${l.path} —— ${l.ok ? '已落库' : l.reason}`));
      }
    }

    const actions = el('div', 'ne-modal-actions');
    const btnClose = el('button', 'ne-btn ne-btn-primary', '关闭');
    btnClose.type = 'button';
    btnClose.dataset.sfx = 'closePanel';
    actions.appendChild(btnClose);
    card.appendChild(actions);

    overlay.appendChild(card);
    root.appendChild(overlay);

    const close = () => {
      if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch { /* 忽略 */ } blobUrl = null; }
      boy.detach();
      boyFrameHolder.el = null;
      overlay.remove();
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    btnClose.addEventListener('click', close);

    /* 编辑区回填活动脚本。**没有脚本时留空而不是塞示例** —— 塞了示例会让玩家
       以为自己已经有了一份，而且他改的内容在没建脚本时会存不下来。
       想看示例点「放回示例」，那是明确的一次写入。 */
    ta.value = activeScript()?.text ?? '';

    syncFromConfig();
  }

  btnImport.addEventListener('click', openImport);

  /* ---------------------------------------------------------------- *
   * 存档
   * ---------------------------------------------------------------- */

  function save() {
    if (!storage) { appendSystem('这个环境不允许本地存储，存档不可用', 'warn'); return; }
    try {
      storage.setItem(SAVE_KEY, exportStore(store, { title: '茶馆' }));
      appendSystem('已存档', 'good');
    } catch (e) {
      appendSystem(`存档失败：${e.message}`, 'warn');
    }
  }

  function load() {
    if (!storage) { appendSystem('这个环境不允许本地存储，读档不可用', 'warn'); return; }
    const text = storage.getItem(SAVE_KEY);
    if (!text) { appendSystem('没有找到存档', 'warn'); return; }
    try {
      importToStore(store, text);
      render();
      appendSystem('已读档', 'good');
    } catch (e) {
      appendSystem(`读档失败：${e instanceof SaveError ? e.message : e.message}`, 'warn');
    }
  }

  function undo() {
    if (busy) return;
    if (store.rollback(1)) {
      render();
      appendSystem('已回退一步', 'good');
    } else {
      appendSystem('已经是最早的状态', 'warn');
    }
  }

  function reset() {
    store.replace(createDemoState());
    render();
    appendSystem('已重新开始', 'good');
  }

  /* 存档 / 读档 / 回退 / 重开 的入口已收进齿轮设置 */

  // 左侧状态宽屏默认展开；右侧书架默认收起，鼠标贴右缘才滑出来
  if (window.innerWidth > 960) {
    body.classList.add('has-left');
    btnSide.classList.add('is-active');

    if (window.matchMedia('(hover: hover)').matches) {
      const edge = 52;
      const shelfWidth = 336;
      let pending = 0;
      window.addEventListener('mousemove', (e) => {
        if (pending) return;
        pending = window.requestAnimationFrame(() => {
          pending = 0;
          const near = e.clientX > window.innerWidth - edge;
          const away = e.clientX < window.innerWidth - shelfWidth - 14;
          // 贴右缘唤出；离开就收 —— 但用把手点开过的保持打开
          if (near && !shelfHovered && !shelfPinned) {
            shelfHovered = true;
            audio.hover();
            applyShelf();
          } else if (away && shelfHovered) {
            shelfHovered = false;
            applyShelf();
          }
        });
      }, { passive: true });
    } else {
      // 没有 hover 能力的设备：书架默认展开（原先这句 add('has-right')
      // 会被随后的 applyShelf() 抹掉，等于没写）
      shelfHovered = true;
      applyShelf();
    }
  }

  // 到这里 body / drawerRight 都已初始化，再对一次抽屉位移。
  // 提前调用会踩 TDZ：Cannot access 'body' before initialization ——
  // 那会让整个 startMain 崩在半路，页面只剩下的顶栏（实测踩过一次）。
  applyShelf();

  /* BGM：只有带雨的模式有（world.rainLevel > 0）。
     用户能听到声音的前提是先有过交互 —— 进主界面这一步就是点击，
     AudioContext 此时解锁，可以直接起。 */
  if (world.rainLevel > 0) {
    audio.unlock();
    audio.bgm.start();
  }

  render();
  refreshModelState();
  scrollToEnd();

  /** 进场：毛玻璃波浪从中心荡开到边缘 */
  function playEnterFx() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    ensureAudio();
    audio.wave();

    const veil = el('div', 'reveal-veil');
    const ring = el('div', 'reveal-ring');
    document.body.append(veil, ring);
    app.classList.add('pre-enter');

    window.setTimeout(() => {
      app.classList.add('entering');
      veil.classList.add('run');
      window.setTimeout(() => {
        veil.remove();
        ring.remove();
        app.classList.remove('pre-enter', 'entering');
      }, 1850);
    }, 60);
  }

  playEnterFx();

  return {
    getState: () => store.getState(),
    stop: () => atmosphere.destroy(),
    save, load, undo, reset,
  };
}

/* ══════════════════════════════════════════════════════════════
 * 启动场景：茶馆门面 / 三入口 / 新茶向导
 * ══════════════════════════════════════════════════════════════ */

function renderBoot(host) {
  if (readMode() === 'rainnight') document.body.classList.add('mode-rainnight');

  const scene = el('div', 'scene-boot');
  const bootAtmos = buildAtmosphere(scene);

  const hero = el('div', 'boot-hero');

  /* 装饰：一行回纹分隔（纯 CSS，无素材）。标题上方压一条，把"两个字"撑成一块匾 */
  const crest = el('div', 'boot-crest');
  crest.appendChild(el('span', 'boot-crest-rule'));
  crest.appendChild(el('span', 'boot-crest-gem'));
  crest.appendChild(el('span', 'boot-crest-rule'));
  hero.appendChild(crest);

  hero.appendChild(el('h1', 'boot-brand', '茶 馆'));
  hero.appendChild(el('p', 'boot-tagline', '通 用 叙 事 引 擎'));

  /* 文学介绍：两行短句，逐字挂 --i，做**二级**错相循环变色 ——
     一级是整句的三色循环，二级是每个字按序号延迟，合成一道流动的色波。 */
  const VERSE = [
    '雨落檐角，茶凉了再续；',
    '有人推门，故事便从头再讲一遍。',
  ];
  const verse = el('p', 'boot-verse');
  let chIndex = 0;
  for (const line of VERSE) {
    const row = el('span', 'boot-verse-line');
    for (const ch of line) {
      const s = el('span', 'boot-verse-ch', ch);
      s.style.setProperty('--i', String(chIndex++));
      row.appendChild(s);
    }
    verse.appendChild(row);
  }
  hero.appendChild(verse);

  const menu = el('div', 'boot-menu');

  const hasSave = (() => {
    try {
      return Boolean(storage?.getItem(saveKeyFor(readMode())));
    } catch {
      return false;
    }
  })();

  const imports = { worldbook: [], characters: [] };

  const itemNew = bootItem('sparkles', '立即开始', '导入世界书与角色卡 · 配好环境 · 开一壶新茶',
    () => openWizard(scene, imports, () => enter()));
  const itemCont = bootItem('history', '继续游戏',
    hasSave ? '从上次的故事接着讲' : '这个模式下还没有存档',
    hasSave ? () => enter({ load: true }) : null);
  const itemSandbox = bootItem('cup', '体验模式', '什么都不导入，直接坐下听一段',
    () => enter());

  [itemNew, itemCont, itemSandbox].forEach((item) => {
    attachSpot(item);
    menu.appendChild(item);
  });

  /* 模式切换：放到页面最底部的独立一条，不再夹在菜单里 */
  const foot = el('div', 'boot-foot');
  const modeRow = el('div', 'boot-modes');
  for (const m of [{ id: 'tea', label: '茶馆标准' }, { id: 'rainnight', label: '雨夜模式' }]) {
    const b = el('button', `boot-mode${readMode() === m.id ? ' is-on' : ''}`);
    b.dataset.sfx = 'select';
    b.type = 'button';
    b.appendChild(el('span', 'boot-mode-name', m.label));
    b.appendChild(el('span', 'boot-mode-sub', m.id === 'rainnight' ? '边界机制 · 暗色主题' : '通用引擎 · 白玻璃'));
    b.addEventListener('click', () => {
      writeMode(m.id);
      document.body.classList.toggle('mode-rainnight', m.id === 'rainnight');
      modeRow.querySelectorAll('.boot-mode').forEach((x) => {
        const on = x === b;
        x.classList.toggle('is-on', on);
        // 联动：选中态迁移时，另一侧反向轻推一下 —— 让"换过去"这一步看得见
        if (!on) {
          x.classList.remove('is-nudged');
          void x.offsetWidth;
          x.classList.add('is-nudged');
        }
      });
    });
    modeRow.appendChild(b);
  }
  foot.appendChild(modeRow);

  scene.append(hero, menu, foot);
  host.appendChild(scene);

  function enter(opts = {}) {
    audio.unlock();
    scene.classList.add('is-leaving');
    window.setTimeout(() => {
      bootAtmos.destroy();
      scene.remove();
      startMain(host, { mode: readMode(), bootImports: imports, ...opts });
    }, 560);
  }
}

function bootItem(ic, title, sub, onClick) {
  const item = el('button', 'boot-item');
  item.type = 'button';
  item.dataset.sfx = 'select';     // 三入口是"挑一条路"，不是提交
  const icWrap = el('span', 'boot-item-ic');
  icWrap.appendChild(el('i', `ic ic-${ic}`));
  item.appendChild(icWrap);
  const text = el('span');
  text.appendChild(el('span', 'boot-item-title', title));
  text.appendChild(el('span', 'boot-item-sub', sub));
  item.appendChild(text);

  if (!onClick) {
    item.classList.add('is-disabled');
    item.disabled = true;
  } else {
    item.addEventListener('click', onClick);
  }
  return item;
}

/** 新茶向导：世界书 → 角色卡 → 环境，三步各自可跳过 */
function openWizard(scene, imports, onDone) {
  const overlay = el('div', 'ne-modal');
  const card = el('div', 'ne-modal-card');

  // 每一步都有自己的分类：不是三个贴着标签的同款输入框，是三条不同的解析入口
  const steps = [
    { title: '① 导入世界书', hint: 'SillyTavern 世界书 JSON —— 认不出的内容会如实告诉你', kind: KIND.WORLDBOOK, label: '世界书' },
    { title: '② 导入角色卡', hint: '角色卡 V1 / V2（JSON 或 PNG），内嵌设定一并读出', kind: KIND.CHARACTER, label: '角色卡' },
    { title: '③ 配置环境', hint: '接入模型；不接也能玩，正文走预写文本', kind: null, label: '环境' },
  ];

  let step = 0;
  let pendingParse = null;

  const head = el('h2', 'ne-modal-title', steps[0].title);
  const hintEl = el('p', 'ne-modal-note', steps[0].hint);
  const body = el('div');
  const status = el('p', 'ne-import-preview');
  enableDrop(status, async (f) => applyParse(await parseImportFile(f)));
  const dots = el('div', 'book-tabs');
  dots.style.justifyContent = 'center';
  steps.forEach((s, i) => dots.appendChild(el('span', `book-tab${i === 0 ? ' is-on' : ''}`, s.title.slice(0, 6))));

  const actions = el('div', 'ne-modal-actions');
  const btnBack = el('button', 'ne-btn', '上一步');
  const btnSkip = el('button', 'ne-btn', '跳过这步');
  const btnNext = el('button', 'ne-btn ne-btn-primary', '下一步');
  btnBack.type = btnSkip.type = btnNext.type = 'button';
  btnBack.dataset.sfx = 'back';       // 往回走
  btnSkip.dataset.sfx = 'back';       // 跳过 = 不在这步停留，同样是"往前挪开"，用后撤音收尾
  btnNext.dataset.sfx = 'confirm';    // 往前一步 = 确认
  btnBack.disabled = true;
  actions.append(btnBack, btnSkip, btnNext);

  card.append(head, hintEl, dots, body, status, actions);
  overlay.appendChild(card);
  scene.appendChild(overlay);

  const fields = {};

  function applyParse(result) {
    status.innerHTML = '';
    pendingParse = null;
    if (!result || result.kind === KIND.UNKNOWN) {
      for (const w of result?.warnings ?? ['还没读到内容']) status.appendChild(el('p', 'ne-modal-warn', w));
      return;
    }
    if (result.kind === KIND.CHARACTER) {
      status.appendChild(el('p', 'ne-import-line', `角色卡 · ${result.actor?.name ?? '未命名'}（${result.spec}），设定 ${result.book.length} 条`));
    } else if (result.kind === KIND.WORLDBOOK) {
      status.appendChild(el('p', 'ne-import-line', `世界书 · ${result.entries.length} 条`));
    } else if (result.kind === KIND.PRESET) {
      status.appendChild(el('p', 'ne-import-line', `预设 · ${result.name ?? '未命名'}`));
    }
    pendingParse = result;
  }

  /** 当前步期望的分类；③ 步不接内容 */
  function expect() {
    return steps[step].kind ? { kind: steps[step].kind, label: steps[step].label } : null;
  }

  function fileInput() {
    const row = el('label', 'ne-field');
    row.appendChild(el('span', 'ne-field-label', '选择文件'));
    const input = el('input', 'ne-field-input');
    input.type = 'file';
    input.accept = steps[step].kind === KIND.CHARACTER ? '.json,.png,application/json,image/png' : '.json,application/json';
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return;
      applyParse(await parseImportFile(f, expect()));
    });
    row.appendChild(input);
    return row;
  }

  function pasteArea() {
    const row = el('label', 'ne-field');
    row.appendChild(el('span', 'ne-field-label', '或直接粘 JSON'));
    const area = el('textarea', 'ne-field-area');
    area.rows = 4;
    area.addEventListener('input', () => {
      const t = area.value.trim();
      if (!t) { applyParse(null); return; }
      try {
        const raw = JSON.parse(t);
        const e = expect();
        applyParse(e ? importAs(raw, e.kind, e.label) : importAny(raw));
      } catch (err) {
        applyParse({ kind: KIND.UNKNOWN, warnings: [`不是合法 JSON：${err.message}`] });
      }
    });
    row.appendChild(area);
    return row;
  }

  function configForm() {
    const cfg = readConfig(storage);
    const wrap = el('div');
    for (const spec of FIELD_SPEC) {
      const row = el('label', 'ne-field');
      row.appendChild(el('span', 'ne-field-label', spec.label));
      const box = el('input', 'ne-field-input');
      box.type = spec.type;
      box.placeholder = spec.hint;
      box.value = cfg[spec.key] ?? '';
      box.autocomplete = 'off';
      fields[spec.key] = box;
      row.appendChild(box);
      wrap.appendChild(row);
    }
    return wrap;
  }

  function renderStep() {
    body.innerHTML = '';
    head.textContent = steps[step].title;
    hintEl.textContent = steps[step].hint;
    dots.querySelectorAll('.book-tab').forEach((d, i) => d.classList.toggle('is-on', i === step));
    btnBack.disabled = step === 0;
    const last = step === steps.length - 1;
    // 最后一步不再挂两个「都能收尾」的按钮 —— 「完成」会把刚填的配置吞掉
    btnSkip.hidden = last;
    btnSkip.textContent = '跳过这步';
    btnNext.textContent = last ? '开 茶' : '下一步';
    btnNext.disabled = false;

    if (step === 0) {
      pendingParse = null;
      body.append(fileInput(), pasteArea());
      status.innerHTML = '';
    } else if (step === 1) {
      pendingParse = null;
      body.append(fileInput(), pasteArea());
      status.innerHTML = '';
    } else {
      pendingParse = null;
      body.appendChild(configForm());
      status.innerHTML = '';
    }
  }

  function commit() {
    const k = steps[step].kind;
    if (k === KIND.WORLDBOOK && pendingParse?.kind === KIND.WORLDBOOK) {
      imports.worldbook.push(...pendingParse.entries);
    } else if (k === KIND.CHARACTER && pendingParse?.kind === KIND.CHARACTER) {
      imports.characters.push(pendingParse);
    } else if (step === steps.length - 1) {
      const cfg = {
        endpoint: fields.endpoint?.value.trim() ?? '',
        apiKey: fields.apiKey?.value.trim() ?? '',
        model: fields.model?.value.trim() ?? '',
      };
      writeConfig(storage, cfg);
    }
  }

  function finish() {
    overlay.remove();
    onDone();
  }

  btnNext.addEventListener('click', () => {
    commit();
    if (step < steps.length - 1) {
      step += 1;
      renderStep();
      return;
    }
    finish();
  });

  btnSkip.addEventListener('click', () => {
    // 跳过不等于丢弃：这一步已解析到的内容照样落库，③ 步的配置也照样保存
    commit();
    if (step < steps.length - 1) {
      step += 1;
      renderStep();
      return;
    }
    finish();
  });

  btnBack.addEventListener('click', () => {
    if (step > 0) {
      step -= 1;
      renderStep();
    }
  });

  renderStep();
}
