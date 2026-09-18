/**
 * 茶馆小二 · iframe 侧注入脚本（源码字符串，运行时注入进 iframe）。
 *
 * ## 与上游的分工
 *
 * 上游 `JS-Slash-Runner/src/iframe/predefine.js` 把这套东西**搬进** iframe：
 *
 *     _.merge(window, _.pick(window.parent, ['EjsTemplate','TavernHelper',...]))
 *
 * 也就是把父窗口的整个 API 面桥进来 —— 从此 iframe 与宿主同权。
 * 代价是要在父窗口挂 316 行 Proxy/MutationObserver 去擦地
 * （`cleanup_protector.js`，实读确认）。
 *
 * **茶馆不这么干。** 这里注入的脚本：
 *   1. **不碰 window.parent 的任何属性**（只调它的 postMessage）
 *   2. 能力全在 `window.teahouse` 上，且是**发消息-等回执**的形状
 *   3. 拿不到宿主 document、拿不到 jQuery、拿不到 Vue
 *
 * 代价：脚本画不出浮在茶馆界面上的悬浮窗。
 * 收益：**不需要那 316 行**。地一直是干净的，因为它没被碰过。
 *
 * ## 这个文件怎么用
 *
 * 它是**纯字符串**（不 import、不 export 值），由 `ui/app.js` 拼进 iframe 的
 * HTML 里。之所以做成一个导出字符串而不是模板文件，是因为产物要单文件、
 * 不能有外部请求 —— 字符串拼进 blob 是最省事的路子。
 */

export const BOY_FRAME_API = `
(function () {
  'use strict';

  var seq = 0;
  var waiters = new Map();
  var listeners = new Map();
  var config = { enabled: false, mode: 'readonly', strict: true };
  var READY = false;

  function call(dir, payload) {
    return new Promise(function (resolve, reject) {
      if (!READY && dir !== 'hello') {
        reject(new Error('茶馆小二还没接到宿主，等一下再用'));
        return;
      }
      var id = 'r' + (++seq);
      waiters.set(id, { resolve: resolve, reject: reject });
      // 宿主侧永远是 window.parent（脚本跑在 iframe 里）
      parent.postMessage(Object.assign({ __teahouse: true, dir: dir, id: id }, payload || {}), '*');
      // 10 秒不回执就当失败，免得脚本 await 到天荒地老
      setTimeout(function () {
        if (waiters.has(id)) {
          waiters.delete(id);
          reject(new Error('宿主没有回执（' + dir + '）'));
        }
      }, 10000);
    });
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__teahouse !== true) return;

    if (d.dir === 'reply') {
      var w = waiters.get(d.id);
      if (!w) return;
      waiters.delete(d.id);
      if (d.ok) w.resolve({ value: d.value, changes: d.changes });
      else w.reject(new Error(d.error || '宿主拒绝了这次请求'));
      return;
    }

    if (d.dir === 'config') {
      config = d.config || config;
      window.teahouse.meta.mode = config.mode;
      window.teahouse.meta.strict = config.strict !== false;
      clearInterval(helloTimer);
      return;
    }

    if (d.dir === 'hello') {
      config = d.config || config;
      window.teahouse.meta.mode = config.mode;
      window.teahouse.meta.strict = config.strict !== false;
      // 宿主在 hello 里带了事件名表，之前一直没接 —— 于是 teahouse.events
      // 永远是空的，脚本没法枚举/校验事件名。这里补上。
      if (Array.isArray(d.events)) window.teahouse.events = d.events.slice();
      clearInterval(helloTimer);
      READY = true;
      window.teahouse.meta.ready = true;
      fire('ready', { config: config });
      return;
    }

    if (d.dir === 'emit') {
      fire(d.type, d.payload || {});
      return;
    }
  });

  function fire(type, payload) {
    var set = listeners.get(type);
    if (!set) return;
    set.forEach(function (fn) {
      try { fn(payload); } catch (e) {
        console.error('[茶馆小二] 监听 ' + type + ' 时出错：', e);
      }
    });
  }

  function writable() {
    if (!config.enabled) throw new Error('茶馆小二没有打开');
    if (config.mode !== 'write') throw new Error('当前是「只读」档，写不了（去设置里改成「可写」）');
  }

  window.teahouse = {
    /* ── 只读 ──────────────────────────────────────────── */
    read: {
      snapshot: function () { return call('read', { what: 'snapshot' }).then(pick); },
      state:    function () { return call('read', { what: 'state' }).then(pick); },
      turn:     function () { return call('read', { what: 'turn' }).then(pick); },
      actors:   function () { return call('read', { what: 'actors' }).then(pick); },
      /* 世界书条目，只给结构（id / 标题 / 分栏 / 触发词 / 是否启用），不给正文 */
      bookEntries: function () { return call('read', { what: 'bookEntries' }).then(pick); },
      world:    function () { return call('read', { what: 'world' }).then(pick); },
    },

    /* ── 写（仅「可写」档；硬约束下只收字面值） ─────────── */
    write: {
      set: function (path, value) {
        writable();
        return call('write', { path: path, value: value, op: 'set' });
      },
      addStat: function (actorId, key, delta) {
        writable();
        return call('write', { path: 'actors.' + actorId + '.stats.' + key, value: delta, op: 'add' });
      },
      addClue: function (clueId) {
        writable();
        return call('write', { path: 'clues', value: clueId });
      },
      say: function (text) {
        writable();
        return call('say', { text: String(text == null ? '' : text) });
      },
      request: function (text) {
        writable();
        return call('request', { text: String(text == null ? '' : text) });
      },
    },

    /* ── 事件 ─────────────────────────────────────────── */
    on: function (type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      var set = listeners.get(type);
      return function () { set.delete(fn); };
    },
    once: function (type, fn) {
      var off = window.teahouse.on(type, function (p) { off(); fn(p); });
      return off;
    },

    /* ── 渲染 ─────────────────────────────────────────── */
    render: {
      /* 把引擎能认的声明式标记画进指定容器（复用宿主的卡片渲染规则是不可能的
         —— 那条规则在宿主里。这里退一步：脚本自己给 HTML 字符串，我们只做
         「插进去」这一件事，而且只允许插进脚本自己给的容器。 */
      html: function (target, htmlText) {
        var node = typeof target === 'string' ? document.querySelector(target) : target;
        if (!node) throw new Error('找不到要渲染的容器：' + target);
        node.innerHTML = String(htmlText == null ? '' : htmlText);
        return node;
      },
      text: function (target, value) {
        var node = typeof target === 'string' ? document.querySelector(target) : target;
        if (!node) throw new Error('找不到要渲染的容器：' + target);
        node.textContent = String(value == null ? '' : value);
        return node;
      },
      toast: function (msg) { return call('toast', { text: String(msg == null ? '' : msg) }); },
    },

    /* ── 元信息 ───────────────────────────────────────── */
    meta: { ready: false, mode: 'readonly', strict: true, version: '1.0' },
    /* 事件名表。收到宿主的 hello 后填成数组 —— 用 Array 而不是 {}，
       这样 includes() / length 都自然可用，和宿主发的形状一致。 */
    events: [],
    __fire: fire,
  };

  function pick(res) { return res && 'value' in res ? res.value : res; }

  // 主动报户口。
  //
  // **必须重试** —— 单发一次是不够的，这一点是实测出来的：
  // blob / opaque origin 的 iframe 刚挂上时，宿主那边 frame.contentWindow
  // 可能还是 null（宿主正是拿它当 postMessage 的目标）。宿主那条 config
  // 回执一旦落在这段窗口里就丢了，而帧这边只报一次户口，
  // 于是**永远**停在 READY=false：脚本 await 什么都超时，页面却毫无报错。
  // 症状就是"帧脚本跑了、hello 也发了、就是没反应"。
  // 现在每 400ms 重报一次，直到拿到宿主的 hello/config 为止。
  function announce() {
    try { parent.postMessage({ __teahouse: true, dir: 'hello' }, '*'); } catch (e) { /* 忽略 */ }
  }
  announce();
  var helloN = 0;
  var helloTimer = setInterval(function () {
    if (READY || ++helloN > 40) { clearInterval(helloTimer); return; }
    announce();
  }, 400);

  // 页面卸载时撤掉所有订阅 —— 别让 iframe 里的定时器继续指向已死的回调
  window.addEventListener('pagehide', function () {
    clearInterval(helloTimer);
    listeners.clear();
    waiters.forEach(function (w) { w.reject(new Error('小二已关闭')); });
    waiters.clear();
  });
})();
`;

/**
 * 把小二 API 包进一份最小 HTML。
 *
 * 刻意**不带**任何第三方库：上游会注入 jQuery / jQuery-UI / Vue / Vue-Router /
 * tailwind / FontAwesome（`third_party_message.html` 实读），全是从 CDN 拉的。
 * 茶馆的产物不许有外部请求，所以这里只有脚本自己的代码。
 * 脚本真要用库，自己 `<script src>` —— 那是脚本作者的选择，不是宿主的默认。
 */
/**
 * script 的收尾标签，**拆成两半拼**。
 *
 * 为什么：产物是单个 HTML，所有模块内联进一个 `<script>`。
 * HTML 解析器**不认识字符串、注释、正则** —— 它在 JS 里看到 `<` + `/script`
 * 就立刻收尾，后面的代码全变成页面文本。症状是
 * `Uncaught SyntaxError: Unexpected identifier 'tb'`，而错误行号指向一个
 * 完全无关的数据文件（因为解析提前终止了）。
 *
 * 所以任何要在字符串里写出这个标签的地方，都必须打散它。
 * 这不是洁癖：本轮就因为这个白屏过一次。
 */
const SCRIPT_CLOSE = '<' + '/script>';

/**
 * 文档收尾标签，同样打散。
 *
 * 理由和 SCRIPT_CLOSE 一样，但**触发它的是工具链而不是浏览器**：
 * `tools/smoke.mjs` 与各种探针脚本都靠「把文档收尾标签替换掉」往产物里
 * 插验证代码。产物里一旦出现第二个收尾标签（哪怕在 JS 字符串或注释里），
 * 注入就会打到**错的那个**上 —— 表现是"探针没跑出来"，而页面本身看起来正常。
 * 本轮就是这样白查了一轮。
 *
 * 所以：任何要在字符串里写出文档收尾标签的地方，一律拆开拼。
 * `build.js` 里有对应的产物闸门，写错会直接构建失败。
 */
const HTML_CLOSE = '<' + '/html>';
const BODY_CLOSE = '<' + '/body>';
const HEAD_CLOSE = '<' + '/head>';
const STYLE_CLOSE = '<' + '/style>';

/** 把一段文本里所有"看起来像收尾标签"的地方打散（防止提前收尾） */
function defuse(text) {
  return String(text ?? '').replace(/<\/(script)/gi, '<\\/$1');
}

export function boyFrameHtml(userHtml, userCss = '', userScript = '') {
  const safeCss = String(userCss ?? '').replace(/<\/style/gi, '<\\/style');
  return [
    '<!doctype html>',
    '<html lang="zh"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<style>',
    '  :root { color-scheme: light dark; }',
    '  html, body { margin: 0; padding: 0; }',
    '  body {',
    '    font: 13px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;',
    '    color: #e8eef7; background: transparent; padding: 10px 12px;',
    '  }',
    '  ::-webkit-scrollbar { width: 8px; height: 8px; }',
    '  ::-webkit-scrollbar-thumb { background: rgba(150,170,200,.35); border-radius: 4px; }',
    '  #tb-error {',
    '    font: 12px/1.6 ui-monospace, Menlo, Consolas, monospace;',
    '    white-space: pre-wrap; word-break: break-word;',
    '    color: #ffb4b4; background: rgba(200,60,60,.14);',
    '    border: 1px solid rgba(220,90,90,.4); border-radius: 8px; padding: 8px 10px; margin-top: 8px;',
    '  }',
    '  #tb-error:empty { display: none; }',
    safeCss,
    STYLE_CLOSE + HEAD_CLOSE + '<body>',
    '<div id="tb-root">', userHtml || '', '</div>',
    '<div id="tb-error"></div>',
    '<script>', BOY_FRAME_API, SCRIPT_CLOSE,
    '<script>',
    '(function () {',
    '  var box = document.getElementById("tb-error");',
    '  function show(msg) { box.textContent = box.textContent ? box.textContent + "\\n" + msg : msg; }',
    '  window.addEventListener("error", function (e) {',
    '    show("脚本出错：" + (e.message || e.type) + (e.lineno ? " @" + e.lineno : ""));',
    '  });',
    '  window.addEventListener("unhandledrejection", function (e) {',
    '    var r = e.reason;',
    '    show("未处理的 Promise 拒绝：" + (r && r.message ? r.message : String(r)));',
    '  });',
    '})();',
    SCRIPT_CLOSE,
    '<script>', defuse(userScript || ''), SCRIPT_CLOSE,
    BODY_CLOSE + HTML_CLOSE,
  ].join('\n');
}

/**
 * 从玩家给的 HTML 里挑出 script 块的内容。
 *
 * 为什么不直接把用户的 HTML 整个丢进去、让它自己的 `<script>` 执行：
 * 因为 `tb-error` 这个错误兜底写在了用户脚本**之后**，
 * 用户脚本若同步报错就会先炸。抽出脚本来、放到兜底之后执行，
 * 报错才能被框住 —— 这是「脚本出错要看得见」的唯一保证。
 *
 * 注意本文件里拼标签一律用 {@link t} 系列的常量，不写字面量 ——
 * 理由见 SCRIPT_CLOSE 的注释。
 */
function extractScripts(html) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out.join('\n;\n');
}

/** 把玩家 HTML 里的 script 块剥掉（它们的正文已经由 extractScripts 取出） */
export function stripScripts(html) {
  return String(html ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

/**
 * 组装一份完整的、可以塞进 iframe 的小二文档。
 *
 * ## 两段式：先拆，再拼
 *
 * 玩家给的是一份 HTML，里面可能既有 DOM 又有 `<script>`。拼装时
 * 必须把它们**分开对待**：DOM 部分进 `#tb-root`，script 部分抽出来、
 * 放到错误兜底**之后**再执行（否则玩家脚本同步报错时兜底来不及装）。
 *
 * ## 踩过的坑（别改回去）
 *
 * 曾经写成 `boyFrameHtml(stripScripts(html))` —— 先剥掉 script，
 * 再指望 `boyFrameHtml` 里的 `extractScripts` 去抽。结果抽的是
 * **已经被剥掉的字符串**，永远抽出空串：玩家脚本压根不执行，
 * 页面安安静静什么都不发生。正确做法是**在这里拆一次**，
 * 把两半各自传下去。
 */
export function buildBoyDocument(userHtml) {
  const raw = String(userHtml ?? '');
  return boyFrameHtml(stripScripts(raw), '', extractScripts(raw));
}
