/**
 * 单文件打包器 —— 把 ESM 模块、示例数据与界面内联成一个 .html。
 *
 * 为什么不用 bundler：
 *   · 项目是零依赖的，装一个打包器就把「零依赖」破了；
 *   · 源文件风格统一（顶格 import / export，不用 export default，不用别名重导出），
 *     正则转换足够可靠；
 *   · 产物必须能被人工读懂，出问题时能直接在 HTML 里定位。
 *
 * 转换规则（只处理这四种写法，超出范围的写法会在这里报错而不是静默漏掉）：
 *   import { a, b } from './x.js';   →  const { a, b } = __req('./x.js');
 *   export function foo              →  function foo      （登记导出）
 *   export const BAR / class Baz     →  const BAR / class Baz
 *   export { a, b };                 →  （删除，登记导出）
 *
 * 用法：node build.js
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** 依赖顺序无关紧要（用注册表按需加载），但列全，漏一个会在运行时抛错 */
const MODULES = [
  'src/schema.js',
  'src/condition.js',
  'src/parser.js',
  'src/state.js',
  'src/worldbook.js',
  'src/macros.js',
  'src/boundary.js',
  'src/engine.js',
  'src/save.js',
  'src/importers.js',
  'src/llm.js',
  'src/style.js',
  'src/narrator.js',
  'src/context.js',
  'src/prompts.js',
  'src/regex.js',
  'src/freechat.js',
  'src/card.js',
  'src/scenePanel.js',
  'src/resources.js',
  'src/intimacy.js',
  'src/director.js',
  'src/swipe.js',
  'src/boy.js',
  'src/boyFrame.js',
  'data/demo.js',
  'data/mode-rain.js',
  'ui/audio.js',
  'ui/atmosphere.js',
  'ui/fluid.js',
  'ui/app.js',
];

const ENTRY = 'ui/app.js';
const STYLES = 'ui/styles.css';
const OUT = '茶馆.html';
const TITLE = '茶馆 · 通用叙事引擎';

const toId = (rel) => './' + rel.split('\\').join('/');

function resolveSpec(fromRel, spec) {
  if (!spec.startsWith('.')) {
    throw new Error(`模块 ${fromRel} 引用了非相对路径 ${JSON.stringify(spec)}，单文件打包不支持外部依赖`);
  }
  const abs = resolve(ROOT, dirname(fromRel), spec);
  return toId(relative(ROOT, abs));
}

function transform(rel, code) {
  const exported = new Set();
  /** 记下「从哪个模块要了哪些名字」，出了 build 之后跨模块核对 */
  const imported = [];
  let out = code;

  if (/export\s+default/.test(out)) {
    throw new Error(`${rel} 使用了 export default，打包器不支持`);
  }
  if (/export\s+\*/m.test(out)) {
    throw new Error(`${rel} 使用了 export *，打包器不支持`);
  }

  // import { a, b as c } from './x.js';
  out = out.replace(
    /^[ \t]*import\s*\{([\s\S]*?)\}\s*from\s*(['"])([^'"]+)\2[ \t]*;?[ \t]*$/gm,
    (_, list, _q, spec) => {
      const id = resolveSpec(rel, spec);
      const names = list
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => {
          const parts = s.split(/\s+as\s+/).map(x => x.trim());
          return parts.length === 2 ? `${parts[0]}: ${parts[1]}` : parts[0];
        })
        .join(', ');
      imported.push({
        from: id,
        names: list.split(',').map(x => x.split(/\s+as\s+/)[0].trim()).filter(Boolean),
      });
      return `const { ${names} } = __req(${JSON.stringify(id)});`;
    },
  );

  // export { a, b };
  out = out.replace(/^[ \t]*export\s*\{([\s\S]*?)\}[ \t]*;?[ \t]*$/gm, (_, list) => {
    for (const raw of list.split(',')) {
      const parts = raw.trim().split(/\s+as\s+/).map(x => x.trim()).filter(Boolean);
      const name = parts[parts.length - 1];
      if (!name) continue;
      if (!new RegExp(`(function|const|let|var|class)\\s+${name}\\b`).test(out)) {
        throw new Error(`${rel} 里 export { ${name} } 找不到对应的模块内定义（重导出不支持）`);
      }
      exported.add(name);
    }
    return '';
  });

  // export function foo / export async function foo / export const BAR / export class Baz
  out = out.replace(
    /^[ \t]*export\s+(async\s+)?(function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm,
    (_, asyncKw, kind, name) => {
      exported.add(name);
      return `${asyncKw ?? ''}${kind} ${name}`;
    },
  );

  const leftovers = out.match(/^[ \t]*export\b/gm);
  if (leftovers) {
    throw new Error(`${rel} 里还有 ${leftovers.length} 处未处理的 export 写法`);
  }

  return { code: out, exported: [...exported], imported };
}

function moduleChunk(rel) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) throw new Error(`找不到模块：${rel}`);

  const raw = readFileSync(path, 'utf8');
  const { code, exported, imported } = transform(rel, raw);

  IMPORT_EDGES.push({ rel, imported });
  EXPORTS_BY_MODULE.set(toId(rel), new Set(exported));

  return [
    `__def(${JSON.stringify(toId(rel))}, function (__req) {`,
    code,
    `return { ${exported.join(', ')} };`,
    `});`,
  ].join('\n');
}

/** 内联资产：CSS/JS 里写 __ASSET_名字__ 或 __SND_名字__，这里换成 data URI。单文件不等于零资产。 */
const ASSETS = {
  JBMONO_WOFF2: 'assets/fonts/JBMono-sub.woff2',
  HOVER: 'assets/sounds/hover.wav',
  PICK: 'assets/sounds/pick.wav',
  TOGGLE: 'assets/sounds/toggle.wav',
  BEGINS: 'assets/sounds/begins.wav',
  SETTLES: 'assets/sounds/settles.wav',
  UNLOCK: 'assets/sounds/unlock.wav',
  DENY: 'assets/sounds/deny.wav',
  CONFIRM: 'assets/sounds/confirm.wav',
  ENDING: 'assets/sounds/ending.wav',
  // 以下 5 个补自 Kenney Interface Sounds 完整包（CC0，经 Calinou/kenney-interface-sounds 打包）
  BACK: 'assets/sounds/back.wav',
  CLOSE: 'assets/sounds/close.wav',
  SELECT: 'assets/sounds/select.wav',
  BONG: 'assets/sounds/bong.wav',
  DROP: 'assets/sounds/drop.wav',
  // BGM：OpenGameArt「ObservingTheStar」片段，CC0。
  // 原曲 2.1MB，这里按 MPEG 帧边界截到前 547KB（约 30 余秒）循环播放。
  BGM: 'assets/bgm/rain-night.mp3',
};

/** 图标：Tabler Icons（MIT）单色 SVG → CSS mask，颜色跟随 currentColor */
const ICONS = {
  settings: 'assets/icons/settings.svg',
  book: 'assets/icons/book-2.svg',
  trophy: 'assets/icons/trophy.svg',
  users: 'assets/icons/users.svg',
  world: 'assets/icons/world.svg',
  rain: 'assets/icons/cloud-rain.svg',
  // 启动页三入口（原先用 emoji 当图标，headless 与部分字体会渲染成方块）
  sparkles: 'assets/icons/sparkles.svg',
  history: 'assets/icons/history.svg',
  cup: 'assets/icons/cup.svg',
  x: 'assets/icons/x.svg',
  chevron: 'assets/icons/chevron.svg',
};

function inlineAsset(relPath) {
  const p = join(ROOT, relPath);
  if (!existsSync(p)) throw new Error(`找不到资产：${relPath}`);
  const ext = relPath.split('.').pop().toLowerCase();
  const mime = {
    woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf',
    png: 'image/png', json: 'application/json', wav: 'audio/wav', mp3: 'audio/mpeg',
  }[ext] ?? 'application/octet-stream';
  return `data:${mime};base64,${readFileSync(p).toString('base64')}`;
}

const IMPORT_EDGES = [];
/** rel -> Set(导出名)，由 moduleChunk 填充 */
const EXPORTS_BY_MODULE = new Map();

/**
 * 跨模块校验：别人从你这儿 import 的名字，你到底导出了没有。
 *
 * 为什么必须有这道闸：打包器把 `import { a } from './x.js'` 直接改写成
 * `const { a } = __req('./x.js')`。目标模块没有导出 a 时，解构结果是
 * **undefined，不报错**。于是 `defaultStack(undefined)` 这种一路裸奔到运行期，
 * 症状是"某个面板空白""某段提示词凭空消失"，而构建日志一片绿。
 *
 * 这个坑是真踩过的：`ui/app.js` 从 narrator.js 取 NARRATION_SYSTEM，
 * 而后者只是 import 它自用、没放进导出表 —— 构建成功、页面能开、
 * 引擎叙事规则那条锁定条目内容是空的。
 */
function checkImports(exportsByModule) {
  const problems = [];
  for (const { rel, imported } of IMPORT_EDGES) {
    for (const { from, names } of imported) {
      const target = exportsByModule.get(from);
      if (!target) {
        problems.push(`${rel} import 了不存在的模块 ${from}`);
        continue;
      }
      for (const n of names) {
        if (!target.has(n)) {
          problems.push(`${rel} 从 ${from} 取的 ${n} 没有被导出`);
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      '跨模块导入校验失败（这些名字在运行期会是 undefined，不会报错）：\n  '
      + problems.join('\n  '),
    );
  }
}

function build() {
  IMPORT_EDGES.length = 0;
  EXPORTS_BY_MODULE.clear();
  const chunks = [];
  for (const rel of MODULES) chunks.push(moduleChunk(rel));
  // moduleChunk 已把导出表填进 EXPORTS_BY_MODULE；全部模块走完再跨模块核对
  checkImports(EXPORTS_BY_MODULE);

  let chunksJoined = chunks.join('\n\n');

  const cssPath = join(ROOT, STYLES);
  if (!existsSync(cssPath)) throw new Error(`找不到样式文件：${STYLES}`);
  let css = readFileSync(cssPath, 'utf8');

  // CSS 走 __ASSET_，JS 走 __SND_（历史约定），同一张资产表
  for (const [key, relPath] of Object.entries(ASSETS)) {
    const data = inlineAsset(relPath);
    css = css.split(`__ASSET_${key}__`).join(data);
    chunksJoined = chunksJoined.split(`__SND_${key}__`).join(data);
  }

  // 图标：每个 SVG 生成一个 mask 类（颜色跟 currentColor）
  let iconCss = '\n.ic{display:inline-block;width:1.06em;height:1.06em;background:currentColor;'
    + '-webkit-mask:var(--ic) center/contain no-repeat;mask:var(--ic) center/contain no-repeat;'
    + 'vertical-align:-0.14em;flex:none;}\n';
  for (const [name, relPath] of Object.entries(ICONS)) {
    const svg = readFileSync(join(ROOT, relPath), 'utf8');
    iconCss += `.ic-${name}{--ic:url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")}\n`;
  }
  css = iconCss + css;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${TITLE}</title>
<style>
${css}
</style>
</head>
<body>
<div id="app"></div>
<script>
"use strict";
(function () {
  var registry = Object.create(null);
  var cache = Object.create(null);

  function __def(id, factory) { registry[id] = factory; }

  function __req(id) {
    if (cache[id]) return cache[id];
    var factory = registry[id];
    if (!factory) throw new Error("模块未打包：" + id);
    var box = {};
    cache[id] = box;
    var out = factory(__req);
    for (var k in out) { if (Object.prototype.hasOwnProperty.call(out, k)) box[k] = out[k]; }
    return box;
  }

${chunksJoined}

  var app = __req(${JSON.stringify(toId(ENTRY))});
  app.mount(document.getElementById("app"));
})();
</script>
</body>
</html>
`;

  // 产物自检：静态资源必须全部内联
  const externals = html.match(/(?:src|href)\s*=\s*["']https?:\/\//g);
  if (externals) {
    throw new Error(`产物含外部资源引用（违反离线约束）：${externals.join(', ')}`);
  }
  if (/^\s*import\s|\bexport\s+(function|const|class|default)/m.test(html)) {
    const m = html.match(/^.*(?:^\s*import\s|\bexport\s+(?:function|const|class|default)).*$/m);
    throw new Error(`产物里还残留 ESM 语法，转换未完成：${m ? m[0].trim().slice(0, 160) : '?'}`);
  }
  if (/__(?:ASSET|SND)_[A-Z0-9_]+__/.test(html)) {
    throw new Error('产物里还有未替换的资产占位符');
  }

  /* 产物自检：内联的脚本里不能出现"看起来像收尾标签"的序列。
   *
   * HTML 解析器不认识 JS 的字符串、注释、正则 —— 它在脚本里看到 `<` `/script`
   * 就当场收尾，剩下的代码全变成页面文本。症状是
   * `Uncaught SyntaxError: Unexpected identifier 'xxx'`，而报错行号指向一个
   * 完全无关的数据文件（解析提前终止，行号已经错位）。
   *
   * 这个坑是真踩过的：`src/boyFrame.js` 要拼一份给 iframe 用的 HTML 文档，
   * 里面有收尾标签，于是整个主脚本被截断、页面白屏，
   * 而 643 项单测全绿（单测看不见 HTML 解析）。
   *
   * ⚠️ 别用 `/<script>(...)<\/script>/` 去"取脚本正文再查" —— 那个正则自己
   * 也会在**第一个**收尾标签处停下（正则同样不认识字符串），于是 offender
   * 正好落在截断之后，闸门永远不响。本轮就是这么白写了一遍。
   * 正确做法：把主脚本正文整段切出来（用最后一个收尾标签定位），直接扫。
   */
  const MAIN_OPEN = html.indexOf('<script>');
  const MAIN_CLOSE = html.lastIndexOf('<' + '/script>');
  if (MAIN_OPEN === -1 || MAIN_CLOSE === -1 || MAIN_CLOSE <= MAIN_OPEN) {
    throw new Error('产物结构异常：找不到主脚本区间');
  }
  const mainBody = html.slice(MAIN_OPEN + '<script>'.length, MAIN_CLOSE);
  const offender = /<\s*\/\s*script/i.exec(mainBody);
  if (offender) {
    const line = html.slice(0, MAIN_OPEN + '<script>'.length + offender.index).split('\n').length;
    const snippet = mainBody
      .slice(Math.max(0, offender.index - 70), offender.index + 24)
      .replace(/\n/g, ' ⏎ ');
    throw new Error(
      '内联脚本里出现了收尾标签，HTML 会提前终止脚本（页面白屏、单测却全绿）：\n'
      + `  产物第 ${line} 行附近：…${snippet}…\n`
      + "  修法：把它拆开拼，例如 '<' + '/script>'（见 src/boyFrame.js 的 SCRIPT_CLOSE）",
    );
  }

  /* 产物自检：文档结构标签必须各出现**一次**。
   *
   * `tools/smoke.mjs` 与各探针靠 `html.replace('</html>', ...)` 注入验证代码 ——
   * replace 打的是**第一个**匹配。产物里一旦出现第二个（哪怕藏在 JS 字符串
   * 或注释里），注入就打到错的地方，症状是"探针没跑出来"而页面看着正常。
   *
   * 本轮就是这么白查了一轮：`src/boyFrame.js` 要拼一份 iframe 用的 HTML 文档，
   * 里面有收尾标签。修法是拆开拼（见该文件的 SCRIPT_CLOSE / HTML_CLOSE）。
   */
  for (const [tag, expect] of [['</html>', 1], ['</head>', 1], ['</body>', 1], ['</script>', 1]]) {
    const n = html.split(tag).length - 1;
    if (n !== expect) {
      const at = html.indexOf(tag);
      const line = html.slice(0, at).split('\n').length;
      throw new Error(
        `产物里 ${tag} 出现了 ${n} 次（应为 ${expect} 次）—— 注入式工具会打错位置：\n`
        + `  首次出现在第 ${line} 行附近\n`
        + '  修法：在源码里把它拆开拼，例如 \'<\' + \'/html>\'',
      );
    }
  }

  const outPath = join(ROOT, OUT);
  writeFileSync(outPath, html, 'utf8');

  const kb = (statSync(outPath).size / 1024).toFixed(1);
  console.log(`已生成：${outPath}`);
  console.log(`体积：${kb} KB`);
  console.log(`模块：${MODULES.length} 个已内联`);
  console.log(`外部请求：0`);
}

build();
