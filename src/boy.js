/**
 * 茶馆小二 —— 自由模式下开给玩家脚本的那扇门。
 *
 * ## 这个模块是什么
 *
 * 它是**宿主侧**的那一半。另一半跑在 iframe 里（`boyFrame.js` 的注入脚本），
 * 两边靠 `postMessage` 通信 —— 之所以不学酒馆助手用「直接共享 window 引用」，
 * 是因为那套会把父窗口的整套 API 搬进 iframe（上游 `predefine.js` 实读结论）：
 * 桥了 API 就挡不住脚本，而且要在父窗口上挂 316 行 Proxy/MutationObserver 去擦地。
 *
 * 茶馆的做法：**用 postMessage 隔一道，能力全在这个文件的白名单里。**
 * 脚本拿不到宿主 window、拿不到 document、拿不到 jQuery。
 *
 * ## 三个开关
 *
 *   总开关  关 → 面板整块不出现，iframe 不加载
 *   读写档  只读 → write 通道不存在，请求直接被拒
 *   硬约束  锁 → 写通道只收**字面常量**，且路径必须是已声明的
 *
 * 默认：关 · 只读 · 锁。
 *
 * ## 为什么写走 applyEffects 而不是直接改 state
 *
 * 项目第一条硬约束是「引擎持有权威状态」。脚本若直接改 `state`，
 * clamp 不会跑、留痕不会记、成就结局不会检 —— 而这三件事正是
 * 「引擎持有权威」的全部含义。所以脚本的写入**组一条 effect**、
 * 走和事件一模一样的那条路（`applyEffects` → `store.commit`）。
 *
 * 结果：存档里看不出哪一处是脚本改的、哪一处是事件改的 —— 它们长得一样。
 * 这是特性，不是缺陷。
 *
 * ## 出处
 *
 * 机制参考 `N0VI028/JS-Slash-Runner`（AGPL-3.0）：它的 iframe 通信、变量作用域、
 * 事件类型清单。**代码全部自写**，只取形状。详见 `docs/teahouse-boy.md`。
 */

/* ------------------------------------------------------------------ *
 * 开关
 * ------------------------------------------------------------------ */

export const BOY_MODES = Object.freeze(['readonly', 'write']);

/** 默认一档都不开：要玩家显式打开 */
export const DEFAULT_BOY = Object.freeze({
  enabled: false,
  mode: 'readonly',
  strict: true,          // 硬约束：锁着
});

export class BoyError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'BoyError';
    this.detail = detail;
  }
}

/** 归一化开关对象。认不出的值一律退回默认（不静默放行）。 */
export function normalizeBoyConfig(raw = {}) {
  const enabled = raw.enabled === true;
  const mode = BOY_MODES.includes(raw.mode) ? raw.mode : DEFAULT_BOY.mode;
  // strict 默认 true：漏填时按「锁着」处理，宁可少给权限
  const strict = raw.strict === false ? false : true;
  return { enabled, mode, strict };
}

/* ------------------------------------------------------------------ *
 * 可写路径声明表
 * ------------------------------------------------------------------ */

/**
 * 脚本能碰的路径。`*` 匹配一段。
 *
 * 这张表是**唯一**的写权限来源 —— 不在这张表里的路径，
 * 无论硬约束开着还是关着，都写不进去。
 *
 * `kind` 的取值：
 *   number    数字，且必须落在 min/max 之间（再交给 state 层的 bounds 夹紧）
 *   enum      取值必须在 `of` 指出的那组里（从世界定义或状态里取）
 *   addOnly   只能加，不能删（数组用 push）
 *   any       任意值（**仅在硬约束关掉时可用**）
 */
export const WRITABLE = Object.freeze({
  'actors.*.stats.*': { kind: 'number', min: -100, max: 200 },
  'flags.*': { kind: 'any', strictOnly: true },
  'clues': { kind: 'addOnly' },
  'where': { kind: 'enum', of: 'places' },
});

/** 松档下额外允许的路径前缀（硬约束关掉才生效） */
const LOOSE_EXTRA = Object.freeze(['flags.']);

/**
 * 引擎独占的路径前缀 —— 无论什么档位都不可写。
 *
 * `$auto` 是引擎自己算出来的观测值（成就数、撤回次数…），不是内容数据。
 * 脚本写它等于让自己骗自己：读到的"成就数"会和真实 `achievements` 脱钩，
 * 而且是**静默**脱钩 —— 引擎下次提交时会把它重算回去，脚本看到的写入
 * 表面上成功了、实际被覆盖。这种"假成功"比报错难查得多。
 */
const ENGINE_OWNED = Object.freeze(['$auto.']);

/**
 * 判断某条路径是否可写。
 * @returns {{ ok: true, rule: object, spec: string } | { ok: false, reason: string }}
 */
export function writablePath(path, { strict = true } = {}) {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, reason: '路径必须是非空字符串' };
  }
  if (path.startsWith('.') || path.endsWith('.') || path.includes('..')) {
    return { ok: false, reason: `路径写法不合法：${path}` };
  }

  // 引擎独占的先挡，且不看档位 —— 它不属于"权限"问题，是"你不该有这个能力"
  for (const prefix of ENGINE_OWNED) {
    if (path.startsWith(prefix) || path === prefix.slice(0, -1)) {
      return {
        ok: false,
        reason: `${path} 是引擎自己算的观测值，脚本不能写（它每次提交都会重算，写了也会被覆盖）`,
      };
    }
  }

  for (const [spec, rule] of Object.entries(WRITABLE)) {
    if (!pathMatches(spec, path)) continue;

    // strictOnly 的规则在松档下才开放（flags.* 就是这一类）
    if (rule.strictOnly && strict) {
      return {
        ok: false,
        reason: `硬约束开着：${spec} 这类自由路径不开放，请关掉硬约束再用 ${path}`,
      };
    }
    return { ok: true, rule, spec };
  }

  // 松档：额外前缀放行
  if (!strict) {
    for (const prefix of LOOSE_EXTRA) {
      if (path.startsWith(prefix)) return { ok: true, rule: { kind: 'any' }, spec: `${prefix}*` };
    }
  }

  return {
    ok: false,
    reason: `写通道不认识这个路径：${path}（可写的是 ${Object.keys(WRITABLE).join(' / ')}）`,
  };
}

/** `actors.*.stats.*` 这种模式匹配。`*` 只匹配一段，且不匹配空段。 */
function pathMatches(spec, path) {
  const a = spec.split('.');
  const b = path.split('.');
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '*') {
      if (!b[i]) return false;
      continue;
    }
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 取值校验
 * ------------------------------------------------------------------ */

/** 值是"字面常量"吗 —— 硬约束档只收这些 */
export function isLiteral(value) {
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value);
  if (t === 'boolean' || t === 'string') return true;
  return false;
}

/**
 * 按声明表校验一个待写入的值。
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkValue(rule, value, ctx = {}) {
  const { strict = true } = ctx;

  if (strict && !isLiteral(value)) {
    return {
      ok: false,
      reason: `硬约束开着：只能写字面值（数字 / 布尔 / 文本），收到 ${
        typeof value === 'object' ? (Array.isArray(value) ? '数组' : '对象') : typeof value}`,
    };
  }

  switch (rule.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, reason: `这个路径要数字，收到 ${typeof value}` };
      }
      if (typeof rule.min === 'number' && value < rule.min) {
        return { ok: false, reason: `值 ${value} 小于下限 ${rule.min}` };
      }
      if (typeof rule.max === 'number' && value > rule.max) {
        return { ok: false, reason: `值 ${value} 大于上限 ${rule.max}` };
      }
      return { ok: true };
    }

    case 'enum': {
      const of = ctx[rule.of];
      if (!Array.isArray(of)) {
        // 拿不到可选值就拒绝，不猜（静默放行是灾难）
        return { ok: false, reason: `无法取得 ${rule.of} 的取值表，拒绝写入` };
      }
      if (!of.includes(value)) {
        return { ok: false, reason: `值 ${JSON.stringify(value)} 不在允许范围内：${of.join(' / ')}` };
      }
      return { ok: true };
    }

    case 'addOnly':
    case 'any':
    default:
      return { ok: true };
  }
}

/* ------------------------------------------------------------------ *
 * 请求 → effect
 * ------------------------------------------------------------------ */

/**
 * 把一个脚本来电转成一条 effect。**不落库**，只做判定与翻译。
 *
 * @param {object} req   `{ kind, path, value }`
 * @param {object} ctx   `{ strict, state, world, places }`
 * @returns {{ ok: true, effect: object } | { ok: false, reason: string }}
 */
export function requestToEffect(req, ctx = {}) {
  const { strict = true, state = null, places = [] } = ctx;

  if (!req || typeof req !== 'object') {
    return { ok: false, reason: '请求必须是对象' };
  }
  if (typeof req.path !== 'string') {
    return { ok: false, reason: '请求缺少 path' };
  }

  const hit = writablePath(req.path, { strict });
  if (!hit.ok) return { ok: false, reason: hit.reason };

  // addOnly：路径本身就是数组，操作用 push，值不能是"整个数组"
  if (hit.rule.kind === 'addOnly') {
    if (req.value === undefined) return { ok: false, reason: `${req.path} 是只增列表，必须给 value` };
    if (Array.isArray(req.value)) {
      return { ok: false, reason: `${req.path} 一次只能加一项，不要传数组` };
    }
    return { ok: true, effect: { path: req.path, op: 'push', value: req.value } };
  }

  const valueCheck = checkValue(hit.rule, req.value, { strict, places });
  if (!valueCheck.ok) return { ok: false, reason: valueCheck.reason };

  // 数值路径：若调用方给了 op 是 add/sub，就用它（增量），否则 set
  const op = ['add', 'sub', 'mul'].includes(req.op) ? req.op : 'set';

  // 增量写入时目标必须已经是数字 —— 否则 state 层才会报错，那时已经晚了。
  // 这里先探一次，把错误位置钉在小二这一层。
  if (op !== 'set' && state) {
    const cur = readPath(state, req.path);
    if (typeof cur !== 'number' || !Number.isFinite(cur)) {
      return { ok: false, reason: `${req.path} 当前不是数字（${typeof cur}），不能用 ${op} 增量` };
    }
  }

  return { ok: true, effect: { path: req.path, op, value: req.value } };
}

/** 按 `a.b.c` 读一个值；读不到返回 undefined（不抛） */
export function readPath(root, path) {
  let cur = root;
  for (const seg of String(path).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 收集本次可用的 enum 取值表 */
export function buildEnumContext(world, state) {
  const places = state?.__places;
  return Array.isArray(places) ? { places } : {};
}

/* ------------------------------------------------------------------ *
 * 只读快照
 * ------------------------------------------------------------------ */

/**
 * 给脚本看的只读快照。
 *
 * **刻意裁过**：不给 `world` 的正文（世界书条目、角色卡描述），
 * 也不给 history 全文 —— 脚本要的是数字与结构，不是剧情。
 * 裁掉这些让快照小、序列化快，也让"脚本能读到什么" 是件可以一眼看完的事。
 */
export function snapshotFor(state, world, view = null) {
  if (!state) return null;
  const actors = Object.values(state.actors ?? {})
    .filter(a => a?.met)
    .map(a => ({
      id: a.id,
      name: world?.actorLabels?.[a.id] ?? a.name ?? a.id,
      stats: Object.fromEntries(
        Object.entries(a.stats ?? {}).map(([k, v]) => [
          world?.statLabels?.[a.id]?.[k] ?? k,
          v,
        ]),
      ),
      bounds: a.bounds ?? {},
    }));

  return {
    turn: (state.history ?? []).length + 1,
    clock: state.clock ? { day: state.clock.day, slot: state.clock.slot } : null,
    slotLabel: world?.slotLabels?.[state.clock?.slot] ?? state.clock?.slot ?? null,
    where: state.where ?? null,
    whereLabel: world?.placeLabels?.[state.where] ?? state.where ?? null,
    actors,
    clues: (state.clues ?? []).map(id => ({
      id,
      name: world?.clueLabels?.[id] ?? id,
    })),
    flags: { ...(state.flags ?? {}) },
    routes: { ...(state.routes ?? {}) },
    ledger: Array.isArray(state.ledger) ? state.ledger.map(r => ({ ...r })) : [],
    achievements: [...(state.achievements ?? [])],
    ending: state.ending ?? null,
    /* 视图是渲染产物，脚本也常要用（进度条的分母之类）。取不到就给 null，不报错 */
    view: view ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * 事件与桥
 * ------------------------------------------------------------------ */

/** 小二事件表。只列**茶馆确实有对应物**的那些，不抄上游那 80 个。 */
export const BOY_EVENTS = Object.freeze({
  'turn:ready': '新一轮就绪（选项已渲染）',
  'turn:finished': '分支已选、状态已落库',
  'free:submitted': '自由对话玩家发言已入库',
  'free:replied': '自由对话模型回复已入库',
  'stream:delta': '流式输出每片',
  'state:changed': '状态被改（含脚本自己改的）',
  'achievement:unlocked': '成就解锁',
  'ending:reached': '走到结局',
});

export function isBoyEvent(type) {
  return Object.prototype.hasOwnProperty.call(BOY_EVENTS, type);
}

/**
 * 桥 —— 宿主侧的收发器。
 *
 * 用法：
 *   const boy = createBoy({ host: () => ({ state, world, store, view }) });
 *   boy.attach(iframeEl);
 *   boy.emit('turn:finished', payload);
 *
 * 它**不碰 DOM 之外的东西**：不发请求、不读文件、不改全局。
 * 所有写入都走调用方传进来的 `apply` 回调 —— 由 UI 决定怎么落库。
 */
export function createBoy(options = {}) {
  const {
    /** () => { state, world, view, places } —— 每次调用现取，避免拿到过期状态 */
    host = () => ({}),
    /** (effects, meta) => { ok, message?, changes? } —— 落库回调，由 UI 提供 */
    apply = null,
  } = options;

  const listeners = new Map();   // type → Set<fn>
  let config = { ...DEFAULT_BOY };
  let frame = null;
  let seq = 0;
  const pending = new Map();     // 请求号 → { resolve, reject, timer }

  /** 未读的小二 → 宿主请求。宿主侧收到后判定、落库、回执。 */
  const log = [];

  function post(msg) {
    if (!frame?.contentWindow) return false;
    try {
      frame.contentWindow.postMessage({ __teahouse: true, ...msg }, '*');
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---- 出站：宿主 → 小二 ---- */

  /** @returns {boolean} 是否真的发出去了一条 —— 返回值就是"发出去没有"，不是计数 */
  function emit(type, payload = {}) {
    if (!config.enabled) return false;
    return post({ dir: 'emit', type, payload, at: Date.now() });
  }

  /* ---- 入站：小二 → 宿主 ---- */

  /**
   * 入站。挂在 window 的 message 事件上。
   *
   * 关于来源校验：iframe 带 `sandbox="allow-scripts"`（**不带**
   * `allow-same-origin`），因此它跑在 **opaque origin** 里 ——
   * 父窗口这边 `frame.contentWindow` 拿到的是一个不透明的代理，
   * 与 `event.source` **不是同一个对象**，不能靠 `===` 认亲。
   *
   * 实测结论：拿 `===` 比对会导致**所有入站消息被静默丢弃**，
   * 症状是"脚本一片安静、报错都没有"。这正是本项目最怕的静默降级。
   *
   * 所以改成两件事一起判：
   *   1. 我们确实有 frame，且它还在文档里（frame.isConnected）
   *   2. 消息带我们的协议标记 `__teahouse === true`
   * 协议标记是**形状**上的约定，脚本伪造它也只能做脚本本来就能做的事
   * （能力仍受读写档与硬约束两道闸限制），所以这不是安全边界。
   * **安全边界是沙箱本身**（隔离 DOM）＋ **白名单**（限制能写什么）。
   */
  function onMessage(event) {
    const data = event?.data;
    if (!data || typeof data !== 'object' || data.__teahouse !== true) return;
    // frame 不在了就别接 —— 免得给一个已销毁的窗口回消息
    if (!frame || (typeof frame.isConnected === 'boolean' && !frame.isConnected)) return;

    switch (data.dir) {
      case 'hello':
        // 小二脚本起来了：回一条配置，让它知道自己的档位
        post({ dir: 'hello', config: { ...config }, events: Object.keys(BOY_EVENTS) });
        return;

      case 'read': {
        const h = host();
        const key = data.what;
        let value = null;
        try {
          value = readResource(key, h);
        } catch (e) {
          post({ dir: 'reply', id: data.id, ok: false, error: e.message });
          return;
        }
        post({ dir: 'reply', id: data.id, ok: true, value });
        return;
      }

      case 'write': {
        const result = handleWrite(data, host(), config, apply);
        log.push({ at: Date.now(), ...result });
        if (log.length > 200) log.shift();
        post({ dir: 'reply', id: data.id, ok: result.ok, error: result.reason ?? null, changes: result.changes ?? null });
        return;
      }

      case 'say':
      case 'request':
      case 'toast':
        // 交给 UI 去接（它知道怎么塞消息、怎么提交输入）
        for (const fn of listeners.get(`@${data.dir}`) ?? []) {
          try { fn(data, config); } catch (e) { /* 单个监听器炸了不影响别的 */ }
        }
        post({ dir: 'reply', id: data.id, ok: true });
        return;

      case 'event':
        // 脚本自己 emit 的小二事件 —— 只在 iframe 内部回环，不进引擎
        return;

      default:
        return;
    }
  }

  function handleWrite(data, h, cfg, applyFn) {
    if (cfg.mode !== 'write') {
      return { ok: false, reason: '当前是「只读」档，写通道没有打开' };
    }
    if (!h?.state) {
      return { ok: false, reason: '引擎还没有状态，现在不能写' };
    }
    if (typeof applyFn !== 'function') {
      return { ok: false, reason: '宿主没有提供落库回调' };
    }

    const conv = requestToEffect(
      { path: data.path, value: data.value, op: data.op },
      { strict: cfg.strict, state: h.state, world: h.world, places: h.places },
    );
    if (!conv.ok) return { ok: false, reason: conv.reason };

    try {
      const res = applyFn([conv.effect], { source: 'boy', path: data.path });
      return { ok: true, changes: res?.changes ?? null };
    } catch (e) {
      // state 层的报错（bounds 缺失、类型不对…）原样透给脚本，
      // 这样脚本作者看到的是引擎的真实口径，而不是一句"写入失败"
      return { ok: false, reason: e.message };
    }
  }

  /**
   * 世界书条目 → 只含结构字段的投影。
   *
   * **必须显式挑字段，不能 `...entry` 展开。** 条目里同时住着结构信息
   * （id / 触发词 / 是否启用 / 插入位置）和正文（`content` 是条目正文，
   * `secondary` 是副键）。`world` 通道的原则是「只给结构性信息，不给正文」，
   * 一次展开就会把正文漏出去，而且以后世界书加新正文字段时会**自动**跟着漏 ——
   * 白名单是唯一能挡住"未来新增字段"的形状。
   *
   * `heading` / `category` 给：它们是条目的展示名与分栏标签，本来就显示在
   * UI 的条目列表里，属于"条目有哪些"这个层面的信息，不是内容本身。
   */
  function projectBookEntries(books) {
    const entries = Array.isArray(books?.entries) ? books.entries : null;
    if (!entries) return null;
    return entries.map(e => ({
      id: e.id,
      heading: e.heading ?? null,
      category: e.category ?? null,
      keys: Array.isArray(e.keys) ? [...e.keys] : [],
      enabled: e.enabled !== false,
      constant: e.constant === true,
    }));
  }

  function readResource(what, h) {
    switch (what) {
      case 'snapshot': return snapshotFor(h.state, h.world, h.view);
      case 'state': return h.state ? structuredClone(h.state) : null;
      case 'turn': return h.state ? (h.state.history ?? []).length + 1 : 0;
      case 'actors': return snapshotFor(h.state, h.world)?.actors ?? [];
      case 'bookEntries': return projectBookEntries(h.books);
      case 'world': {
        const w = h.world ?? {};
        // 只给结构性信息，不给正文（世界书条目 / 角色描述都不给）
        return {
          id: w.id ?? null,
          title: w.title ?? null,
          actorLabels: w.actorLabels ?? {},
          statLabels: w.statLabels ?? {},
          slotLabels: w.slotLabels ?? {},
          placeLabels: w.placeLabels ?? {},
          clueLabels: w.clueLabels ?? {},
          statBounds: w.statBounds ?? {},
          eventIds: Array.isArray(w.events) ? w.events.map(e => e.id) : [],
        };
      }
      default:
        throw new BoyError(`读通道不认识这个资源：${what}（可用：snapshot / state / turn / actors / bookEntries / world）`);
    }
  }

  /* ---- 生命周期 ---- */

  function attach(el) {
    frame = el ?? null;
    if (frame) {
      frame.setAttribute('data-teahouse-boy', '1');
    }
  }

  function detach() {
    if (frame) frame.removeAttribute('data-teahouse-boy');
    frame = null;
    listeners.clear();
    // 解掉 store 订阅：否则小二关着时每次状态变更都白跑一遍
    //（emit 会因为 config.enabled 为 false 直接返回，但订阅本身还在跑）
    unbindStore?.();
    unbindStore = null;
    for (const [, p] of pending) {
      try { p.reject(new BoyError('小二已关闭')); } catch { /* 忽略 */ }
    }
    pending.clear();
  }

  function setConfig(next) {
    config = normalizeBoyConfig({ ...config, ...next });
    post({ dir: 'config', config: { ...config } });
    return { ...config };
  }

  /** UI 想接住脚本的 say / request / toast，从这里挂 */
  function onLocal(kind, fn) {
    const key = `@${kind}`;
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => listeners.get(key)?.delete(fn);
  }

  /**
   * 把引擎的 store 订阅转成小二事件。**可选** —— 不调它桥照常工作，
   * 只是脚本收不到 `state:changed`。
   *
   * 为什么要宿主显式接一次，而不是在桥里自己轮询：桥拿不到 store
   * （`host()` 只给状态快照，不给写通道），而订阅必须挂在**唯一提交点**上 ——
   * 手发会漏（本项目的写入口有十来个）并且顺序不可控。
   *
   * 重复绑定会先解掉上一次，免得挂了两份、事件发两遍。
   *
   * @param {{ subscribe: (fn) => (() => void) }} store
   * @returns {() => void} 解绑函数
   */
  let unbindStore = null;
  function bindStore(store) {
    if (typeof store?.subscribe !== 'function') {
      throw new BoyError('bindStore 需要带 subscribe 的 store');
    }
    unbindStore?.();
    unbindStore = store.subscribe((meta) => {
      emit('state:changed', {
        turn: meta?.turn ?? null,
        mode: meta?.mode ?? null,
        // changes 只有 dispatch / commit 给得出；replace / rollback 是整表恢复，
        // 没有逐条 diff。取不到就给 null —— 脚本该按"状态变了"处理，别指望总有 diff。
        changes: Array.isArray(meta?.changes)
          ? meta.changes.map(c => ({ path: c.path, op: c.op, from: c.from, to: c.to, skipped: c.skipped }))
          : null,
      });
    });
    return () => { unbindStore?.(); unbindStore = null; };
  }

  return {
    attach,
    detach,
    emit,
    setConfig,
    onLocal,
    /** 把 store 的状态变更接成 state:changed —— 见上方注释，可选 */
    bindStore,
    getConfig: () => ({ ...config }),
    onMessage,
    get log() { return log.slice(); },
    get frame() { return frame; },
    nextId: () => ++seq,
  };
}
