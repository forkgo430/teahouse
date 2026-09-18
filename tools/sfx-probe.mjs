/**
 * 音效链路探针 —— 用 headless Chrome 跑产物，注入 AudioContext 探针，
 * 数「真的发生了几次 decodeAudioData / createBufferSource / src.start()」。
 *
 * 为什么必须这么测：这个项目吃过亏 —— `world.rainLevel` 是 undefined 时
 * `undefined > 0` 恒 false，音效从来没启动过，**但零报错**。
 * 所以判据不是"没报错"，而是"硬计数有没有涨"。
 *
 * 同时抓 console 里的 [SFX] 日志（产物带 __SFX_DEBUG 时才有）。
 *
 * 用法：node tools/sfx-probe.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PRODUCT = join(ROOT, '茶馆.html');
const TMP = join(ROOT, '.tmp');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '<HOME>/AppData/Local/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find(p => existsSync(p));
if (!chrome) { console.error('找不到浏览器，设 CHROME_PATH'); process.exit(2); }
if (!existsSync(PRODUCT)) { console.error('先跑 node build.js'); process.exit(2); }

/* 探针：在产物脚本之前注入，包住 AudioContext 的关键方法 */
const PROBE = `
<script>
window.__SFX = {
  logs: [],
  decode: 0, decodeOk: 0, decodeFail: 0,
  srcCreated: 0, srcStarted: 0,
  oscCreated: 0, oscStarted: 0,
  gains: 0,
  decodeNames: [],
  ctxCount: 0,
};
(function () {
  const S = window.__SFX;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { S.logs.push('NO_AUDIOCONTEXT'); return; }

  const _decode = AC.prototype.decodeAudioData;
  AC.prototype.decodeAudioData = function (buf, ok, err) {
    S.decode += 1;
    const byteLen = buf && buf.byteLength;
    S.decodeNames.push(byteLen);
    const p = _decode.call(this, buf, ok, err);
    if (p && p.then) {
      p.then(() => { S.decodeOk += 1; }, () => { S.decodeFail += 1; });
    }
    return p;
  };

  const _cbs = AC.prototype.createBufferSource;
  AC.prototype.createBufferSource = function () {
    S.srcCreated += 1;
    const node = _cbs.call(this);
    const _start = node.start.bind(node);
    node.start = function (...a) {
      S.srcStarted += 1;
      if (S._lastTag) S._startTags = (S._startTags || []).concat(S._lastTag);
      return _start(...a);
    };
    return node;
  };

  const _cosc = AC.prototype.createOscillator;
  AC.prototype.createOscillator = function () {
    S.oscCreated += 1;
    const node = _cosc.call(this);
    const _s = node.start.bind(node);
    node.start = function (...a) { S.oscStarted += 1; return _s(...a); };
    return node;
  };

  const _cg = AC.prototype.createGain;
  AC.prototype.createGain = function () { S.gains += 1; return _cg.call(this); };

  // AudioContext 构造计数（ready() 只应造一个）
  const Orig = AC;
  function Wrapped(...a) { S.ctxCount += 1; return new Orig(...a); }
  Wrapped.prototype = Orig.prototype;
  window.AudioContext = Wrapped;
  if (window.webkitAudioContext) window.webkitAudioContext = Wrapped;

  // 抓 console 里的 [SFX]
  const _log = console.log;
  console.log = function (...a) {
    const s = a.map(String).join(' ');
    if (s.includes('[SFX]')) S.logs.push(s);
    _log.apply(console, a);
  };
  const _warn = console.warn;
  console.warn = function (...a) {
    const s = a.map(String).join(' ');
    if (s.includes('[SFX]')) S.logs.push(s);
    _warn.apply(console, a);
  };
  const _err = console.error;
  console.error = function (...a) {
    const s = a.map(String).join(' ');
    if (s.includes('[SFX]')) S.logs.push(s);
    _err.apply(console, a);
  };
})();
window.__SFX_ERRORS = [];
window.addEventListener('error', e => window.__SFX_ERRORS.push(String(e.message)));
window.addEventListener('unhandledrejection', e => window.__SFX_ERRORS.push('rej: ' + String(e.reason && e.reason.message || e.reason)));
</script>
`;

/* 驱动脚本：进主界面 → 点一批标了 data-sfx 的按钮 → 回报计数 */
const DRIVER = `
<script>
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function q(s) { return document.querySelector(s); }
function clickText(sel, text) {
  const el = [...document.querySelectorAll(sel)].find(x => x.textContent.includes(text));
  if (el) el.click();
  return el;
}
const R = { steps: [], errors: [] };
window.__SFX._lastTag = 'boot';
async function run() {
 try {
  await wait(500);
  R.steps.push(['boot 后', JSON.parse(JSON.stringify(window.__SFX))]);

  // 模拟真人：pointerdown（解锁音频）+ click
  function pd(el) {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  }

  const bootItem = clickText('.boot-item', '体验模式');
  if (bootItem) pd(bootItem);
  await wait(1200);

  window.__SFX._lastTag = 'after-boot';
  R.steps.push(['进主界面后', JSON.parse(JSON.stringify(window.__SFX))]);
  R.inMain = !!q('.ne-app') && !!q('.ne-topbar');
  R.hasApp = !!q('.ne-app');

  // 数一数按钮上有多少标了 data-sfx
  const allBtns = [...document.querySelectorAll('button, [role="button"]')];
  R.btnCount = allBtns.length;
  R.sfxTagged = allBtns.filter(b => b.dataset && b.dataset.sfx).length;

  // 依次点一批真实按钮（齿轮、状态、导入、书架把手）
  const targets = [];
  for (const b of document.querySelectorAll('.ne-icon-btn')) targets.push(['icon-btn:' + b.textContent.trim(), b]);
  const sh = q('.shelf-handle'); if (sh) targets.push(['shelf-handle', sh]);

  for (const [name, b] of targets) {
    const before = window.__SFX.srcStarted + window.__SFX.oscStarted;
    window.__SFX._lastTag = name;
    pd(b);
    await wait(260);
    const after = window.__SFX.srcStarted + window.__SFX.oscStarted;
    R.steps.push(['点 ' + name, { 发声数: after - before, srcStarted: window.__SFX.srcStarted, oscStarted: window.__SFX.oscStarted }]);
  }

  // 设置面板里点几个开关
  const gear = [...document.querySelectorAll('.ne-icon-btn')].find(b => /设置/.test(b.textContent));
  if (gear) { pd(gear); await wait(600); }
  R.modalOpen = !!q('.ne-modal');
  if (R.modalOpen) {
    const btns = [...document.querySelectorAll('.ne-modal button')].filter(b => b.textContent.trim().length <= 8).slice(0, 12);
    R.modalBtnSfx = btns.map(b => b.dataset.sfx || '(缺)');
    for (const b of btns.slice(0, 8)) {
      const before = window.__SFX.srcStarted + window.__SFX.oscStarted;
      window.__SFX._lastTag = 'modal:' + b.textContent.trim().slice(0, 6);
      pd(b);
      await wait(200);
      const after = window.__SFX.srcStarted + window.__SFX.oscStarted;
      R.steps.push(['点模态框 ' + b.textContent.trim().slice(0, 8), { 发声数: after - before }]);
    }
  }

  R.final = JSON.parse(JSON.stringify(window.__SFX));
  R.errors = window.__SFX_ERRORS.slice();
 } catch (e) {
  R.errors.push('driver: ' + e.message);
 } finally {
  const out = document.createElement('pre');
  out.id = 'SFX_OUT';
  out.textContent = JSON.stringify(R);
  document.body.appendChild(out);
  document.title = 'SFX_DONE';
 }
}
setTimeout(run, 100);
</script>
`;

mkdirSync(TMP, { recursive: true });
const html = readFileSync(PRODUCT, 'utf8');
let file = html.replace('<script>\n"use strict";', PROBE + '<script>\n"use strict";');
if (file === html) { console.error('注入探针失败：找不到产物入口脚本位置'); process.exit(2); }
const mod = 'tearain';
try { /* no-op */ } catch {}
// 雨夜模式才起 BGM / 雨声
file = file.replace('</body>', DRIVER + '</body>');
const outFile = join(TMP, 'sfx-probe.html');
// 用雨夜模式，才能验证 BGM 与雨声
writeFileSync(outFile, file, 'utf8');

// 探针里先设 localStorage 再加载太晚，改在 URL 里不行 —— 用一次性注入
const withMode = readFileSync(outFile, 'utf8')
  .replace(PROBE, PROBE + '<script>try { localStorage.setItem("ne.mode", "rainnight"); } catch (e) {}</script>');
writeFileSync(outFile, withMode, 'utf8');

const res = spawnSync(chrome, [
  '--headless=new', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  '--run-all-compositor-stages-before-draw',
  '--virtual-time-budget=40000',
  '--window-size=1093,813',
  '--dump-dom',
  'file:///' + outFile.replace(/\\/g, '/'),
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const dom = res.stdout ?? '';
const m = dom.match(/<pre id="SFX_OUT">([\s\S]*?)<\/pre>/);
if (!m) {
  console.log('✗ 探针没跑完');
  console.log(dom.slice(0, 2000));
  process.exit(1);
}
const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const R = JSON.parse(raw);

console.log('=== 进主界面 ===', R.inMain ? 'OK' : '失败');
console.log('按钮总数 =', R.btnCount, ' 标了 data-sfx 的 =', R.sfxTagged);
console.log('\n=== 各阶段 AudioContext 计数 ===');
for (const [label, s] of R.steps) {
  if (typeof s === 'object' && s.发声数 !== undefined) {
    console.log(`  ${label.padEnd(28)} 发声数=${s.发声数}  src=${s.srcStarted}  osc=${s.oscStarted}`);
  } else {
    console.log(`  ${label}: decode=${s.decode} decodeOk=${s.decodeOk} decodeFail=${s.decodeFail} srcCreated=${s.srcCreated} srcStarted=${s.srcStarted} oscCreated=${s.oscCreated} oscStarted=${s.oscStarted} ctx=${s.ctxCount}`);
  }
}
console.log('\n=== 最终计数 ===');
console.log(JSON.stringify(R.final, null, 2));
console.log('\n=== [SFX] 日志（前 40 条）===');
console.log((R.final.logs || []).slice(0, 40).join('\n') || '(无)');
console.log('\n=== 报错 ===');
console.log((R.errors || []).join('\n') || '(无)');
