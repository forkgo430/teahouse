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
import { nextTurn, applyTurn, buildView, TurnRejected } from '../src/engine.js';
import { createStore, applyEffects, hashState } from '../src/state.js';
import { exportStore, importToStore, SaveError } from '../src/save.js';
import { createClient, readConfig, writeConfig, clearConfig } from '../src/llm.js';
import { createDirector } from '../src/director.js';
import { labelForPath, resolveValue } from '../src/narrator.js';
import { defaultStack, buildSystemMessage } from '../src/prompts.js';
import { budgetStatus } from '../src/context.js';
import { importAny, importAs, importPngCard, KIND } from '../src/importers.js';
import { createWorldbook } from '../src/worldbook.js';
import { canAdvance, CONSENT, consentEffects, withdrawEffects, renegotiateEffects } from '../src/boundary.js';
import { DEFAULT_VARIANT_COUNT, MAX_VARIANTS, variantsOf, swipeState, stepVariant, selectVariantEffects } from '../src/swipe.js';
import { createAtmosphere } from './atmosphere.js';
import { attachFluidShader, TEA_FLUID_PARAMS } from './fluid.js';
import { createAudio } from './audio.js';

const SWIPE_KEY = 'ne.swipe.count';
const SOUND_KEY = 'ne.sound.on';

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

function readSwipeCount() {
  try {
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
export function mount(root) {
  renderBoot(root);
}

function startMain(root, opts = {}) {
  const mode = opts.mode ?? readMode();
  // 主题类在这里再兜一次底：启动页只在 renderBoot 里加过一次，
  // 从向导进来、或启动后才切模式时，类就漏了 —— 结果雨夜模式顶着浅色主题跑。
  document.body.classList.toggle('mode-rainnight', mode === 'rainnight');
  const world = createWorldFor(mode);
  const store = createStore(initialStateFor(mode));
  const SAVE_KEY = saveKeyFor(mode);

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
  let promptStack = readJson(STACK_KEY, null) ?? defaultStack('');
  let regexRules = readJson(REGEX_KEY, []);
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
  const btnGear = iconBtn('设置', 'settings');

  topbar.append(brand, spacer, btnSide, btnImport, btnGear);

  /* 右缘把手：平时是一个小圆点，hover 拉成胶囊显示「书架」。
     原本书架只能靠"鼠标贴到右缘"唤出，没有可见入口 —— 触屏与新手都摸不到。 */
  const shelfHandle = el('button', 'shelf-handle');
  shelfHandle.type = 'button';
  shelfHandle.appendChild(el('i', 'ic ic-book'));
  shelfHandle.appendChild(el('span', 'shelf-handle-label', '书架'));
  shelfHandle.setAttribute('aria-label', '打开书架');
  attachRipple(shelfHandle);
  shelfHandle.addEventListener('click', () => {
    body.classList.add('has-right');
    audio.pageTurn();
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

  function narratorNode(record, index) {
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

    box.appendChild(el('p', 'ne-msg-text', record.text ?? branch?.text ?? ''));

    const deltas = deltaPanel(record.changes);
    if (deltas) box.appendChild(deltas);

    if (swipeState(record).canSwipe) box.appendChild(swipeBar(record, index));
    return box;
  }

  /* ── 多版本切换 ─────────────────────────────────────────── */

  function swipeBar(record, turnIndex) {
    const st = swipeState(record);
    const bar = el('div', 'ne-swipe');

    const prev = el('button', 'ne-swipe-btn', '‹');
    prev.type = 'button';
    prev.title = '上一版';
    prev.disabled = !st.canPrev;
    prev.addEventListener('click', () => switchVariant(turnIndex, -1));

    const next = el('button', 'ne-swipe-btn', '›');
    next.type = 'button';
    next.title = '下一版';
    next.disabled = !st.canNext;
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
    audio.swap();

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
      intro.appendChild(el('p', 'ne-msg-text', world.opening));
      stream.appendChild(intro);
      return;
    }

    history.forEach((record, i) => {
      if (record.said) stream.appendChild(playerNode(record.said));
      const node = narratorNode(record, i);
      attachSpot(node);
      stream.appendChild(node);
    });
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
    box.appendChild(el('div', 'ne-actor-route',
      actor.met ? `关系路线 · ${ROUTE_LABEL[actor.route] ?? actor.route}` : '尚未见面'));

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
    audio.pick();
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
    if (mode === 'rainnight') drawerLeft.appendChild(consentSection(view));

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
  function attachRipple(node) {
    node.classList.add('has-ripple');
    const surface = el('span', 'ripple-surface');
    node.appendChild(surface);

    const release = (dot) => {
      const fade = dot.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: RIPPLE.fadeMs, easing: 'linear', fill: 'forwards' },
      );
      fade.onfinish = () => dot.remove();
      fade.oncancel = () => dot.remove();
    };

    node.addEventListener('pointerdown', (e) => {
      const box = node.getBoundingClientRect();
      const w = box.width || 1;
      const h = box.height || 1;

      const maxDim = Math.max(w, h);
      const soft = Math.max(RIPPLE.softEdge * maxDim, RIPPLE.softMin);
      const initial = Math.max(1, Math.floor(maxDim * RIPPLE.originScale));
      const maxRadius = Math.sqrt(w * w + h * h) + 10;
      const scale = (maxRadius + soft) / initial;

      const fromX = e.clientX - box.left - initial / 2;
      const fromY = e.clientY - box.top - initial / 2;
      const toX = w / 2 - initial / 2;
      const toY = h / 2 - initial / 2;

      const dot = el('span', 'ripple-dot');
      dot.style.width = `${initial}px`;
      dot.style.height = `${initial}px`;
      dot.style.transform = `translate(${fromX}px, ${fromY}px) scale(1)`;
      surface.appendChild(dot);

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
        release(dot);
      };
      grow.onfinish = finish;
      node.addEventListener('pointerup', finish, { once: true });
      node.addEventListener('pointercancel', finish, { once: true });
      node.addEventListener('pointerleave', finish, { once: true });
    });
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
      audio.pageTurn();
    };

    spine.setAttribute('role', 'button');
    spine.setAttribute('tabindex', '0');
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
        entry.appendChild(el('span', null, e.heading ?? e.id));
        entry.appendChild(el('span', 'ne-tag', e.keys.length ? e.keys[0] : '常驻'));
        entry.title = e.content;
        listWrap.appendChild(entry);
      }
    }

    for (const c of cats) {
      const tab = el('button', `book-tab${c === activeCat ? ' is-on' : ''}`, c);
      tab.type = 'button';
      tab.addEventListener('click', () => {
        activeCat = c;
        tabs.querySelectorAll('.book-tab').forEach(x => x.classList.toggle('is-on', x.textContent === c));
        audio.pageTurn();
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
      b.addEventListener('click', () => { fn(); overlay.remove(); });
      quick.appendChild(b);
    }
    card.appendChild(quick);

    /* ── 上下文预算 ── */
    const ctxSec = el('section', 'ne-sec');
    ctxSec.appendChild(el('h3', 'ne-sec-title', '上下文预算'));
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
    card.appendChild(ctxSec);

    /* ── 提示词栈 ── */
    const stackSec = el('section', 'ne-sec');
    stackSec.appendChild(el('h3', 'ne-sec-title', '提示词栈'));
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
        if (entry.locked) sw.disabled = true;
        sw.addEventListener('click', () => {
          entry.enabled = !entry.enabled;
          saveStack();
          renderStackUI();
        });
        row.appendChild(sw);

        const ta = el('textarea', 'ne-field-area stack-ta');
        ta.rows = entry.locked ? 2 : 3;
        ta.value = entry.content;
        ta.placeholder = entry.name;
        if (entry.locked) ta.disabled = true;
        ta.addEventListener('change', () => {
          entry.content = ta.value;
          saveStack();
        });
        row.appendChild(ta);
        stackWrap.appendChild(row);

        if (!entry.locked) {
          const del = el('button', 'ne-btn stack-del', '删除');
          del.type = 'button';
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
    card.appendChild(stackSec);

    /* ── 正则后处理 ── */
    const rxSec = el('section', 'ne-sec');
    rxSec.appendChild(el('h3', 'ne-sec-title', '正则后处理'));
    const rxWrap = el('div');

    function saveRx() {
      writeJson(REGEX_KEY, regexRules);
      director = buildDirector();
    }

    function renderRxUI() {
      rxWrap.innerHTML = '';
      for (const rule of regexRules) {
        const row = el('div', 'rx-entry');
        const findIn = el('input', 'ne-field-input rx-mini');
        findIn.value = rule.find;
        findIn.placeholder = '查找（正则）';
        findIn.addEventListener('change', () => {
          rule.find = findIn.value;
          saveRx();
        });
        const repIn = el('input', 'ne-field-input rx-mini');
        repIn.value = rule.replace;
        repIn.placeholder = '替换为';
        repIn.addEventListener('change', () => {
          rule.replace = repIn.value;
          saveRx();
        });
        const del = el('button', 'ne-btn', '删');
        del.type = 'button';
        del.addEventListener('click', () => {
          regexRules = regexRules.filter(r => r.id !== rule.id);
          saveRx();
          renderRxUI();
        });
        row.append(findIn, repIn, del);
        rxWrap.appendChild(row);
      }

      const addRow = el('div', 'rx-add');
      const fIn = el('input', 'ne-field-input rx-mini');
      fIn.placeholder = '查找';
      const rIn = el('input', 'ne-field-input rx-mini');
      rIn.placeholder = '替换为';
      const add = el('button', 'ne-btn', '添加规则');
      add.type = 'button';
      add.addEventListener('click', () => {
        if (!fIn.value) return;
        regexRules.push({
          id: `rx${Date.now()}`,
          name: '自定义',
          find: fIn.value,
          replace: rIn.value,
          scope: 'out',
          enabled: true,
        });
        fIn.value = '';
        rIn.value = '';
        saveRx();
        renderRxUI();
      });
      addRow.append(fIn, rIn, add);
      rxWrap.appendChild(addRow);
    }
    renderRxUI();
    rxSec.appendChild(rxWrap);
    rxSec.appendChild(el('p', 'ne-modal-warn',
      '作用于模型正文。非法正则会自动停用并保留在列表里，改好即恢复。'));
    card.appendChild(rxSec);

    /* 外观：玻璃旋钮（Aqua 同款，实时生效） */
    const appearance = el('section', 'ne-sec');
    appearance.appendChild(el('h3', 'ne-sec-title', '外观 · 玻璃'));
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
    card.appendChild(appearance);

    /* 模型接入 */
    const sec = el('section', 'ne-sec');
    sec.appendChild(el('h3', 'ne-sec-title', '模型接入'));
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
    sndBtn.addEventListener('click', () => {
      const next = !audio.isEnabled();
      audio.setEnabled(next);
      writeSoundOn(next);
      if (next) ensureAudio();
      sndBtn.textContent = next ? '已开启' : '已关闭';
      if (next) audio.confirm();
    });
    sndRow.appendChild(sndBtn);
    sec.appendChild(sndRow);

    sec.appendChild(el('p', 'ne-modal-warn',
      '密钥只存在这台机器的浏览器里。导入的预设会覆盖采样参数与系统提示词。'));

    const actions = el('div', 'ne-modal-actions');
    const btnApply = el('button', 'ne-btn ne-btn-primary', '保存');
    const btnClear = el('button', 'ne-btn', '清除模型配置');
    btnApply.type = btnClear.type = 'button';
    actions.append(btnClear, btnApply);
    sec.appendChild(actions);
    card.appendChild(sec);

    /* 模式与数据 */
    const misc = el('section', 'ne-sec');
    misc.appendChild(el('h3', 'ne-sec-title', '模式与数据'));

    const modeRow = el('div', 'ne-modal-actions');
    modeRow.style.cssText = 'justify-content:flex-start;flex-wrap:wrap;';
    const otherMode = mode === 'rainnight' ? 'tea' : 'rainnight';
    const btnMode = el('button', 'ne-btn',
      `切换到「${otherMode === 'rainnight' ? '雨夜模式' : '茶馆标准'}」（重载）`);
    btnMode.type = 'button';
    btnMode.addEventListener('click', () => {
      writeMode(otherMode);
      window.location.reload();
    });
    modeRow.appendChild(btnMode);

    const btnWipe = el('button', 'ne-btn', '清除全部本地数据');
    btnWipe.type = 'button';
    btnWipe.addEventListener('click', () => {
      try { storage?.clear(); } catch { /* 忽略 */ }
      window.location.reload();
    });
    modeRow.appendChild(btnWipe);
    misc.appendChild(modeRow);
    card.appendChild(misc);

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
      btn.appendChild(el('span', 'ne-choice-key', opt.key));
      btn.appendChild(el('span', null, opt.label));
      if (!opt.available) {
        btn.disabled = true;
        btn.appendChild(el('span', 'ne-choice-why', opt.reason ?? '条件不成立'));
        if (opt.reasonDetail) btn.title = opt.reasonDetail;
        btn.addEventListener('pointerenter', () => audio.hover());
      } else {
        btn.addEventListener('pointerenter', () => audio.hover());
        btn.addEventListener('click', () => {
          ensureAudio();
          audio.pick();
          choose(opened.event, opt.key, '');
        });
      }
      choices.appendChild(btn);
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
      stream.appendChild(box);
    }

    const again = el('button', 'ne-btn ne-btn-primary', '重新开始');
    again.type = 'button';
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
  btnGear.addEventListener('click', () => {
    audio.toggle(true);
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

    if (store.getState().actors[actor.id]) {
      throw new Error(`已经有一个 id 为「${actor.id}」的角色，这份卡会顶掉它 —— 先给卡改个名字`);
    }

    world.actorLabels = { ...(world.actorLabels ?? {}), [actor.id]: actor.name };
    world.statLabels = {
      ...(world.statLabels ?? {}),
      [actor.id]: Object.fromEntries(actor.stats.map(s => [s.key, s.label ?? s.key])),
    };

    let bookNote = '';
    if (book.length > 0) {
      applyWorldbookImport(book, `${actor.name} 的内嵌设定`);
      bookNote = `，带出设定 ${book.length} 条`;
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

    return `已导入角色「${actor.name}」${bookNote}`;
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

    const catRow = el('div', 'ne-import-cats');
    const catBtns = [];
    for (const t of IMPORT_TABS) {
      const b = el('button', `import-cat${t === importTab ? ' is-on' : ''}`);
      b.type = 'button';
      b.appendChild(el('i', `ic ic-${t.icon}`));
      b.appendChild(el('span', 'import-cat-title', t.label));
      b.appendChild(el('span', 'import-cat-sub', t.sub));
      b.addEventListener('click', () => {
        importTab = t;
        catBtns.forEach(x => x.classList.toggle('is-on', x === b));
        audio.pageTurn();
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
    actions.append(btnClose, btnApply);
    card.appendChild(actions);

    overlay.appendChild(card);
    root.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    let pending = null;

    function describe(result) {
      preview.innerHTML = '';
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

      if (result.kind === KIND.CHARACTER) {
        preview.appendChild(el('p', 'ne-import-line', `角色卡 · ${result.actor?.name ?? '未命名'}（${result.spec}）`));
        if (result.greetings.length > 0) preview.appendChild(el('p', 'ne-import-line', `开场白 ${result.greetings.length} 条`));
        if (result.book.length > 0) preview.appendChild(el('p', 'ne-import-line', `内嵌设定 ${result.book.length} 条`));
        if (result.meta?.tags?.length) {
          preview.appendChild(el('p', 'ne-import-line', `标签：${result.meta.tags.join('、')}`));
        }
      } else if (result.kind === KIND.PRESET) {
        preview.appendChild(el('p', 'ne-import-line', `预设 · ${result.name ?? '未命名'}`));
        const s = result.settings ?? {};
        const params = [
          s.temperature !== undefined ? `温度 ${s.temperature}` : null,
          s.topP !== undefined ? `top_p ${s.topP}` : null,
          s.maxTokens !== undefined ? `max_tokens ${s.maxTokens}` : null,
        ].filter(Boolean);
        if (params.length) preview.appendChild(el('p', 'ne-import-line', `采样：${params.join('，')}`));
        if (result.systemPrompt) preview.appendChild(el('p', 'ne-import-line', '含系统提示词'));
      } else {
        preview.appendChild(el('p', 'ne-import-line', `世界书 · ${result.entries.length} 条`));
        if (result.meta?.name) preview.appendChild(el('p', 'ne-import-line', `名称：${result.meta.name}`));
        if (result.meta?.tokenBudget) preview.appendChild(el('p', 'ne-import-line', `预算：${result.meta.tokenBudget} tokens`));
      }

      for (const w of result.warnings) preview.appendChild(el('p', 'ne-modal-warn', w));
      pending = result;
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      describe(await parseImportFile(file, importTab));
    });

    enableDrop(preview, async (file) => describe(await parseImportFile(file, importTab)));

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
          const on = body.classList.contains('has-right');
          if (!on && e.clientX > window.innerWidth - edge) {
            body.classList.add('has-right');
            audio.hover();
          } else if (on && e.clientX < window.innerWidth - shelfWidth - 14) {
            body.classList.remove('has-right');
          }
        });
      }, { passive: true });
    } else {
      body.classList.add('has-right');
    }
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
      audio.pick();
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
