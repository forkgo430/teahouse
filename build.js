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
  'src/narrator.js',
  'src/context.js',
  'src/prompts.js',
  'src/regex.js',
  'src/freechat.js',
  'src/director.js',
  'src/swipe.js',
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

  return { code: out, exported: [...exported] };
}

function moduleChunk(rel) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) throw new Error(`找不到模块：${rel}`);

  const raw = readFileSync(path, 'utf8');
  const { code, exported } = transform(rel, raw);

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

function build() {
  let chunks = MODULES.map(moduleChunk).join('\n\n');

  const cssPath = join(ROOT, STYLES);
  if (!existsSync(cssPath)) throw new Error(`找不到样式文件：${STYLES}`);
  let css = readFileSync(cssPath, 'utf8');

  // CSS 走 __ASSET_，JS 走 __SND_（历史约定），同一张资产表
  for (const [key, relPath] of Object.entries(ASSETS)) {
    const data = inlineAsset(relPath);
    css = css.split(`__ASSET_${key}__`).join(data);
    chunks = chunks.split(`__SND_${key}__`).join(data);
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

${chunks}

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
    throw new Error('产物里还残留 ESM 语法，转换未完成');
  }
  if (/__(?:ASSET|SND)_[A-Z0-9_]+__/.test(html)) {
    throw new Error('产物里还有未替换的资产占位符');
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
