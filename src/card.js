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
 * 茶馆的路线不同：**引擎认识每一个字段**。模型只能产出
 *
 *     [状态栏]
 *     好感度 = 72
 *     疲惫 = 31
 *     [/状态栏]
 *
 * 这种**纯值**的声明，引擎按固定组件集渲染成卡片 —— 不解析 HTML、不执行 JS、
 * 不需要沙箱，因为**根本不存在需要执行的代码**。这与项目「所有条件可判定」
 * 的硬约束一致。
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

/** 行内标记：[前缀:...] */
const INLINE_RE = /\[([^\]:\n]{1,12}):([^\]\n]*)\]/g;

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

    const [, prefix, body] = m;
    if (prefix === '条') {
      // [条:键|当前|上限]
      const [key, cur, max] = body.split('|').map(s => s.trim());
      parts.push({ type: 'bar', key, value: Number(cur), max: Number(max) || 100 });
    } else if (prefix === '签') {
      parts.push({ type: 'tag', text: body.trim() });
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

      const num = Number(it.value);
      // 「72 / 100」这种写法拆成当前值与上限
      const frac = /^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(it.value);

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
        row.appendChild(el('span', 'ne-card-num', frac ? `${cur} / ${max}` : String(cur)));
      } else {
        row.appendChild(el('span', 'ne-card-val', it.value));
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
      container.appendChild(el('span', 'ne-tag', part.text));
    } else if (part.type === 'bar') {
      const pct = part.max > 0 ? Math.max(0, Math.min(100, (part.value / part.max) * 100)) : 0;
      const wrap = el('span', 'ne-inline-bar');
      if (part.key) wrap.appendChild(el('span', 'ne-inline-bar-key', part.key));
      const bar = el('span', 'ne-card-bar');
      const fill = el('i');
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      wrap.appendChild(bar);
      wrap.appendChild(el('span', 'ne-card-num', `${part.value}`));
      container.appendChild(wrap);
    }
  }
  return container;
}
