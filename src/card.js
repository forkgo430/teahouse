/**
 * 结构化正文渲染 —— 把模型输出里的**声明式标记**渲染成 UI 组件。
 *
 * ## 为什么是"声明式"而不是"让 AI 写 HTML"
 *
 * 酒馆那套前端卡是「AI 输出 HTML/JS → 正则捞出来 → 塞进 DOM」。它的安全前提
 * 靠 `destination: display`（不进上下文），但**渲染本身仍要执行 AI 产出的代码**。
 * 读酒馆助手的 `src/iframe/predefine.js` 可确认：它把父窗口整套 API 桥进 iframe
 * —— 也就是说那个 iframe 不是沙箱，桥了 API 就挡不住恶意脚本。
 *
 * **注意**：这**不是**说"茶馆不要渲染层"。渲染层、变量系统、模板引擎都已按
 * 第 3 条落地在 `src/boy.js` + `src/boyFrame.js`（自由模式下的茶馆小二）。
 * 本文件解决的是**另一件事**：主线正文里模型偶尔要吐一块结构化信息
 * （状态栏之类），希望它**不经过执行任何代码**就能渲染成卡片。
 *
 * 两条路分工清楚：
 *   · 卡片的声明式标记（本文件）—— 模型输出、引擎渲染、**零代码执行**，
 *     因为标记里只有**纯值**，引擎认识每一个字段。适合高频、低风险的小块。
 *   · 茶馆小二（`src/boy.js`）—— 玩家**自己写的脚本**跑在沙箱 iframe 里，
 *     能力经白名单读写档限制。适合玩家想深度定制界面的场合。
 *
 * 前者刻意做得窄（见下），不是为了"挡住渲染层"，而是因为**这两类需求的
 * 风险与频率完全不同**，混成一套会让常用路径背上沙箱的全部成本。
 *
 * 这与项目「所有条件可判定」的硬约束一致：卡片字段全可判定。
 *
 * ## 为什么渲染时解析、不写进 history
 *
 * 存档指纹基于 JSON 往返后的内容算（见 MEMORY「设计决定」第 5 条）。
 * 若把渲染产物写进 history，改一次渲染规则就会让旧档"内容变了"、指纹对不上。
 * 所以 history 里永远存原始文本，渲染产物只活在 DOM 里。
 *
 * ## 标记语法（故意做得窄）
 *
 *   [状态栏]            区块开始，`[名]` 单独成行
 *   键 = 值             键值对
 *   [/状态栏]           区块结束
 *
 * 另有行内形式：
 *
 *   [条:好感度|72|100]  进度条
 *   [签:危险]           标签
 *
 * 语法窄是**故意的**：窄才能保证解析结果可判定，也才不会和正文里的方括号
 * 撞车（只有「行首 [名] 单独成行」或「[前缀:…] 完整形式」才算标记）。
 */

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/** 已知区块的组件类型。不在这里的名字一律当普通文本，不做任何渲染。 */
const BLOCKS = Object.freeze({
  状态栏: 'stats',
  属性: 'stats',
  物品栏: 'list',
  背包: 'list',
  在场: 'list',
});

/**
 * 参考块 —— 不进正文，只在设置里展示"卡片长什么样"。
 *
 * 写在这里而不是写死在 UI 里：示例要是硬编码的，改了语法、改了字段名，
 * 面板上的示例就会开始骗人。它必须走**同一条解析路径**，
 * 所以它是数据 + 一个薄薄的调用，不是一段 HTML 片段。
 *
 * ⚠ 真值标记必须写在**值的最末尾**。写成 `72 ✓ / 100` 判定就会失败
 * （@see isTruthMarked），示例会展示成"没有真值标记的样子"，
 * 玩家照着抄就永远做不出带标记的卡片。
 */
export function sampleCardMarkup({ title = '状态栏', actor = '林晚', note = '第 3 天 · 深夜' } = {}) {
  return [
    `[${title}]`,
    note,
    `${actor}·信任 = ${makeTruthMark('72 / 100')}`,
    `${actor}·不安 = ${makeTruthMark('31 / 100')}`,
    `模型自填的天气 = 转冷`,
    `[/${title}]`,
  ].join('\n');
}

/** 行内标记：[前缀:...]，后面可以跟一个真值标记 ` ✓` */
const INLINE_RE = /\[([^\]:\n]{1,12}):([^\]\n]*)\]( ?✓)?/g;

/** 区块开头的形状：[名] 独占一行（前后可有空白） */
const OPEN_RE = /^\[([^\]:\n]{1,12})\]\s*$/;

/**
 * 把一段正文切成「纯文本段」与「组件段」。
 *
 * @param {string} text 模型原始输出
 * @returns {Array<{type:'text',text:string}|{type:'block',kind:string,title:string,items:Array}>}
 */
export function parseCardMarkup(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];

  const lines = raw.split('\n');
  /** @type {Array<object>} */
  const out = [];
  let buf = [];
  let block = null;   // { kind, title, items }

  const flushText = () => {
    if (buf.length === 0) return;
    const joined = buf.join('\n');
    if (joined.trim()) out.push({ type: 'text', text: joined });
    buf = [];
  };

  for (const line of lines) {
    const open = OPEN_RE.exec(line.trim());

    if (block) {
      // 区块内：找结束标记
      if (open && open[1].startsWith('/')) {
        out.push({ type: 'block', ...block });
        block = null;
        continue;
      }
      // 区块内的一行：`键 = 值` 或纯值
      const kv = /^(.{1,24}?)\s*[=＝]\s*(.+)$/.exec(line.trim());
      if (kv) block.items.push({ key: kv[1].trim(), value: kv[2].trim() });
      else if (line.trim()) block.items.push({ key: null, value: line.trim() });
      continue;
    }

    // 区块外：是开始标记吗？
    if (open && !open[1].startsWith('/') && BLOCKS[open[1]]) {
      flushText();
      block = { kind: BLOCKS[open[1]], title: open[1], items: [] };
      continue;
    }

    buf.push(line);
  }

  // 流没闭合就收尾：不吞内容，当成普通块渲染出来（宁可多显示，不可丢）
  if (block) out.push({ type: 'block', ...block });
  flushText();

  return out;
}

/** 取出行内的 [前缀:...] 标记，返回片段数组 */
export function parseInline(text) {
  const src = String(text ?? '');
  const parts = [];
  let last = 0;
  let m;

  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(src)) !== null) {
    if (m.index > last) parts.push({ type: 'text', text: src.slice(last, m.index) });

    const [, prefix, body, mark] = m;
    if (prefix === '条') {
      // [条:键|当前|上限]（后面可跟 ✓ = 引擎真值）
      const [key, cur, max] = body.split('|').map(s => s.trim());
      parts.push({ type: 'bar', key, value: Number(cur), max: Number(max) || 100, truth: mark != null });
    } else if (prefix === '签') {
      parts.push({ type: 'tag', text: body.trim(), truth: mark != null });
    } else {
      // 不认识的前缀 → 原样保留，绝不吃掉玩家的字
      parts.push({ type: 'text', text: m[0] });
    }
    last = m.index + m[0].length;
  }

  if (last < src.length) parts.push({ type: 'text', text: src.slice(last) });
  return parts.length ? parts : [{ type: 'text', text: src }];
}

/**
 * 这段文本里有没有可渲染的标记？
 * UI 用它决定"要不要走结构化渲染"，纯文本时走原路径（省开销）。
 */
export function hasCardMarkup(text) {
  const s = String(text ?? '');
  if (INLINE_RE.test(s)) { INLINE_RE.lastIndex = 0; return true; }
  INLINE_RE.lastIndex = 0;
  return s.split('\n').some(line => {
    const m = OPEN_RE.exec(line.trim());
    return m && !m[1].startsWith('/') && BLOCKS[m[1]];
  });
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/**
 * 把一个区块渲染成 DOM。**全部走 createElement + textContent**，
 * 不用 innerHTML —— 值是模型产出的，永远当不可信文本处理。
 *
 * @param {object} seg parseCardMarkup 的 block 段
 * @param {(tag:string, cls:string, text?:string)=>HTMLElement} el 建元素的小工具
 */
export function renderBlock(seg, el) {
  const card = el('div', `ne-card ne-card-${seg.kind}`);

  const head = el('div', 'ne-card-head');
  head.appendChild(el('span', 'ne-card-title', seg.title));
  card.appendChild(head);

  if (seg.items.length === 0) {
    card.appendChild(el('div', 'ne-card-empty', '（空）'));
    return card;
  }

  if (seg.kind === 'stats') {
    for (const it of seg.items) {
      const row = el('div', 'ne-card-row');

      if (it.key === null) {
        row.appendChild(el('span', 'ne-card-note', it.value));
        card.appendChild(row);
        continue;
      }

      /* 真值标记在**解析前**就在值里（引擎盖章），这里只负责把它画成一个
         看得见的小方块，并从值文本里去掉，免得又显示数字又显示 ✓ 又显示原字符。 */
      const truth = isTruthMarked(it.value);
      const raw = truth ? it.value.slice(0, -2) : it.value;

      const num = Number(raw);
      // 「72 / 100」这种写法拆成当前值与上限
      const frac = /^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(raw);

      row.appendChild(el('span', 'ne-card-key', it.key));

      if (Number.isFinite(num) || frac) {
        const cur = frac ? Number(frac[1]) : num;
        const max = frac ? Number(frac[2]) : 100;
        const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
        const bar = el('div', 'ne-card-bar');
        const fill = el('i');
        fill.style.width = `${pct}%`;
        bar.appendChild(fill);
        row.appendChild(bar);
        const numBox = el('span', 'ne-card-num', frac ? `${cur} / ${max}` : String(cur));
        if (truth) numBox.appendChild(el('span', 'ne-truth', TRUTH_MARK));
        row.appendChild(numBox);
      } else {
        const valBox = el('span', 'ne-card-val', raw);
        if (truth) valBox.appendChild(el('span', 'ne-truth', TRUTH_MARK));
        row.appendChild(valBox);
      }

      card.appendChild(row);
    }
    return card;
  }

  // list：一行一项，带点号
  const ul = el('div', 'ne-card-list');
  for (const it of seg.items) {
    const li = el('div', 'ne-card-item');
    li.appendChild(el('span', 'ne-card-dot'));
    li.appendChild(el('span', 'ne-card-text', it.key ? `${it.key}：${it.value}` : it.value));
    ul.appendChild(li);
  }
  card.appendChild(ul);
  return card;
}

/**
 * 把行内片段渲染进一个容器。
 * @param {HTMLElement} container
 * @param {string} text
 * @param {(tag:string, cls:string, text?:string)=>HTMLElement} el
 */
export function renderInlineInto(container, text, el) {
  for (const part of parseInline(text)) {
    if (part.type === 'text') {
      container.appendChild(document.createTextNode(part.text));
    } else if (part.type === 'tag') {
      const tag = el('span', 'ne-tag', part.text);
      if (part.truth) tag.appendChild(el('span', 'ne-truth', TRUTH_MARK));
      container.appendChild(tag);
    } else if (part.type === 'bar') {
      const pct = part.max > 0 ? Math.max(0, Math.min(100, (part.value / part.max) * 100)) : 0;
      const wrap = el('span', 'ne-inline-bar');
      if (part.key) wrap.appendChild(el('span', 'ne-inline-bar-key', part.key));
      const bar = el('span', 'ne-card-bar');
      const fill = el('i');
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      wrap.appendChild(bar);
      const numBox = el('span', 'ne-card-num', `${part.value}`);
      if (part.truth) numBox.appendChild(el('span', 'ne-truth ne-truth-inline', TRUTH_MARK));
      wrap.appendChild(numBox);
      container.appendChild(wrap);
    }
  }
  return container;
}

/* ------------------------------------------------------------------ *
 * 真值标记 —— 「引擎说的」与「模型说的」得能分开
 * ------------------------------------------------------------------ */

/**
 * 真值标记：写在值后面的一个小方块。
 *
 * 为什么需要它：一张卡片里可能同时有**引擎算出来的数**和**模型顺手编的数**
 * （后者在 destination.prompt 的正则、或模型自发输出结构化值时出现）。
 * 两者的可信度完全不同 —— 引擎的值会影响后续判定，模型的值不会。
 * 不标出来，玩家没法知道"这 72 到底算不算数"。
 *
 * 用文本 `✓` 而不是图标字体：它要能被复制、能被屏幕阅读器读出来。
 */
export const TRUTH_MARK = '✓';

/** 这个值是不是引擎真值？真值的来源只有一处 —— 引擎自己盖的章。 */
export function isTruthMarked(value) {
  return typeof value === 'string' && value.endsWith(` ${TRUTH_MARK}`);
}

/**
 * 给一个值盖真值章。幂等 —— 盖两次不会变成 `72 ✓ ✓`。
 * @param {string|number} value
 */
export function makeTruthMark(value) {
  const s = String(value ?? '');
  return isTruthMarked(s) ? s : `${s} ${TRUTH_MARK}`;
}

/**
 * 引擎真值 → 卡片标记文本。
 *
 * 这是「内容层产出卡片标记」的落点：**由引擎生成，不是等模型自发输出**。
 * 所以卡片是否出现、出现什么字段，完全由数据决定 —— 换个世界定义换一套卡片，
 * 不用动 UI，也不用写进提示词去求模型照做。
 *
 * ## 为什么默认只写变化过的字段
 *
 * 每轮都刷一遍全量状态，会让正文被一张越来越长的表盖住。默认只写这一轮
 * 真正动过的（`changes`），既能对上正文里刚发生的事，也短。
 * 需要看全貌时传 `{ full: true }`，或者直接看左侧的局势面板。
 *
 * ## 形状
 *
 *   [状态栏]               ← 一个字都不变的标题
 *   第 3 天 · 深夜           ← 无 `=` 的行 = 备注行（renderBlock 的 note 分支）
 *   好感度 = 72 ✓ / 100
 *   [/状态栏]
 *
 * @param {object} ctx
 * @param {Array<{path:string,op:string,from:*,to:*,value:*}>} [ctx.changes] 本轮改动
 * @param {object} [ctx.state] 当前状态（full 模式要它）
 * @param {object} [ctx.view]  `buildView(state, world)` 的产物（full 模式要它）
 * @param {object} ctx.world   世界定义（标签映射）
 * @param {(path:string, world:object)=>string} ctx.labelOf  路径 → 人话
 * @param {(path:string, value:*, world:object)=>string} ctx.valueOf 值 → 人话
 * @param {boolean} [ctx.full]  写全量而不是只写变化
 * @param {string} [ctx.title]  区块标题，默认「状态栏」
 * @returns {string} 卡片标记文本；没有可写的内容时返回空串
 */
export function makeStatusCard(ctx = {}) {
  const { changes = [], state = null, view = null, world = null, labelOf, valueOf, full = false } = ctx;
  const title = ctx.title ?? '状态栏';
  const label = typeof labelOf === 'function' ? labelOf : (p) => p;
  const show = typeof valueOf === 'function' ? valueOf : (p, v) => String(v ?? '—');

  const rows = [];
  const seen = new Set();

  /**
   * 角色数值 → `键 = 当前 / 上限 ✓`
   *
   * 真值标记**永远在末尾**。写成分数形式 `72 ✓ / 100` 是不行的 ——
   * 判定只看结尾（`isTruthMarked`），标记落在中间就永远判不出来，
   * 于是"引擎真值"和"模型自填"在渲染层长得一模一样，标记等于没做。
   */
  const statLine = (actorId, actorName, key, value, min, max) => {
    const keyName = world?.statLabels?.[actorId]?.[key] ?? key;
    const frac = (typeof max === 'number' && max > 0)
      ? `${value} / ${max}`
      : `${value}`;
    return `${actorName}·${keyName} = ${makeTruthMark(frac)}`;
  };

  if (full) {
    const actors = view?.actors ?? [];
    for (const a of actors) {
      if (!a.met) continue;
      for (const s of a.stats ?? []) {
        const b = state?.actors?.[a.id]?.bounds?.[s.key];
        rows.push(statLine(a.id, a.name, s.key, s.value, b?.min, b?.max));
      }
    }
  } else {
    for (const c of changes) {
      if (!c?.path || c.path === 'history') continue;
      const statHit = /^actors\.([^.]+)\.stats\.([^.]+)$/.exec(c.path);
      if (statHit) {
        const [, actorId, key] = statHit;
        if (seen.has(c.path)) continue;
        seen.add(c.path);
        const actorName = world?.actorLabels?.[actorId]
          ?? state?.actors?.[actorId]?.name ?? actorId;
        const b = state?.actors?.[actorId]?.bounds?.[key];
        rows.push(statLine(actorId, actorName, key, c.to, b?.min, b?.max));
        continue;
      }
      if (c.path === 'routes.X') continue;
      // 角色数值以外的写操作：照 labelOf/valueOf 的老路走。
      // 但列表类（clues/achievements/endings）本轮推入的是"新增了什么"，
      // 写成 `线索 = 门缝里的光 ✓` 比 `线索 = 3 ✓` 有用。
      if (seen.has(c.path)) continue;
      if (c.path === 'clues' || c.path === 'achievements' || c.path === 'endings') continue;
      seen.add(c.path);
      const shown = c.op === 'push' || c.op === 'pull'
        ? show(c.path, c.value)
        : show(c.path, c.to);
      rows.push(`${label(c.path, world)} = ${makeTruthMark(shown)}`);
    }
    // 列表类收成一行条数，别每轮重复报同一批
    if (view) {
      if (view.clues?.length) rows.push(`已知线索 = ${view.clues.length} ${TRUTH_MARK}`);
      if (view.achievements?.length) rows.push(`成就 = ${view.achievements.length} ${TRUTH_MARK}`);
    }
  }

  // 备注行：时间与地点，永远在最上面
  const clock = view?.clock ?? (state
    ? { day: state.clock?.day, label: world?.slotLabels?.[state.clock?.slot] ?? state.clock?.slot }
    : null);
  const where = view?.where ?? state?.where ?? null;

  const notes = [];
  if (clock?.day != null) notes.push(`第 ${clock.day} 天 · ${clock.label ?? ''}`.trim());
  if (where != null) {
    const place = world?.placeLabels?.[where] ?? where;
    notes.push(String(place));
  }

  if (notes.length === 0 && rows.length === 0) return '';

  // 按 renderBlock 认得的形状写：`[标题]` 独占一行，`键 = 值` 一行一项
  return [
    `[${title}]`,
    ...notes,
    ...rows,
    `[/${title}]`,
  ].join('\n');
}
