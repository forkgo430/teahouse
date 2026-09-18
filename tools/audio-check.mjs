/**
 * 音效链路验证 —— 证明「采样真的被解码并播放」，不是「没报错」。
 *
 * 这个项目吃过「静默降级」的亏：路径没抛错 ≠ 路径被走到。
 * 所以这里数的是**平台级调用**：decodeAudioData 与 createBufferSource 各调了几次。
 *
 * 做法：把产物读进来，在 <head> 插探针（抢在同步主脚本之前包住 AudioContext 原型），
 * 注入一个脚本在 load 后用真实 pointerdown 事件驱动，最后把计数写进 <pre>。
 *
 * 用法：node tools/audio-check.mjs
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
if (!chrome) {
  console.error('找不到 Chrome/Edge，设 CHROME_PATH 环境变量');
  process.exit(2);
}

/* 探针要在主脚本之前跑：主脚本是同步 IIFE，晚插就包不住原型了 */
const HOOK = `<script>
window.__A = { decode: 0, bufSrc: 0, started: 0, errs: [] };
window.addEventListener('error', e => window.__A.errs.push('ERR: ' + e.message));
(function () {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { window.__A.errs.push('无 AudioContext'); return; }
  const d = AC.prototype.decodeAudioData;
  AC.prototype.decodeAudioData = function (...a) { window.__A.decode++; return d.apply(this, a); };
  const c = AC.prototype.createBufferSource;
  AC.prototype.createBufferSource = function (...a) {
    window.__A.bufSrc++;
    const n = c.apply(this, a);
    const s = n.start.bind(n);
    n.start = function (...b) { window.__A.started++; return s(...b); };
    return n;
  };
})();
</script>`;

/* 主脚本之后：驱动真实交互，再把结果写进 DOM */
const DRIVER = `<script>
(function () {
  const fire = (node) => {
    if (!node) return;
    const r = node.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 20);
    const y = r.top + Math.min(r.height / 2, 12);
    for (const type of ['pointerdown', 'pointerup', 'click']) {
      node.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, buttons: type === 'pointerdown' ? 1 : 0, pointerId: 1,
      }));
    }
  };

  // 进主界面：收集所有按钮路径 —— 逐个点，让委托层把各种音色都过一遍
  const done = [];
  const clickAll = (sel, limit) => {
    const nodes = [...document.querySelectorAll(sel)].slice(0, limit);
    for (const n of nodes) {
      try { fire(n); done.push((n.textContent || n.className || '?').trim().slice(0, 12)); } catch (e) {}
    }
    return nodes.length;
  };

  // 先点「开始」之类的入口把音频解锁
  setTimeout(() => {
    clickAll('.boot-mode', 1);
    setTimeout(() => {
      clickAll('.boot-item', 1);
      setTimeout(() => {
        const n1 = clickAll('button', 60);
        setTimeout(() => {
          const n2 = clickAll('[role="button"], .book-spine, .book-tab', 20);

          let status = null;
          try { status = window.__audio && window.__audio.status ? window.__audio.status() : 'audio 未挂到 window'; }
          catch (e) { status = 'status() 抛错: ' + e.message; }

          const out = {
            decode: window.__A.decode,
            bufSrc: window.__A.bufSrc,
            started: window.__A.started,
            buttonsClicked: n1, extraClicked: n2,
            clicked: done,
            status,
            errs: window.__A.errs,
          };
          const pre = document.createElement('pre');
          pre.id = 'AUDIO_OUT';
          pre.textContent = JSON.stringify(out, (_k, v) => (typeof v === 'string' ? v.replace(/[<>&]/g, '') : v));
          document.body.appendChild(pre);
        }, 900);
      }, 700);
    }, 500);
  }, 600);
})();
</script>`;

mkdirSync(TMP, { recursive: true });
const html = readFileSync(PRODUCT, 'utf8');
const file = join(TMP, 'audio-check.html');
writeFileSync(file, html.replace('</head>', HOOK + '</head>').replace('</html>', DRIVER + '</html>'), 'utf8');

const res = spawnSync(chrome, [
  '--headless=new', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  '--run-all-compositor-stages-before-draw',
  '--virtual-time-budget=40000',
  '--window-size=1093,813',
  '--dump-dom',
  'file:///' + file.replace(/\\/g, '/'),
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const dom = res.stdout ?? '';
const m = dom.match(/<pre id="AUDIO_OUT">([\s\S]*?)<\/pre>/);
if (!m) {
  console.log('✗ 探针没跑完');
  const e = dom.match(/ERR[^<\n]{0,200}/);
  if (e) console.log('  ' + e[0]);
  process.exit(1);
}
const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const R = JSON.parse(raw);

console.log('=== 平台级调用计数（硬证据）===');
console.log('  decodeAudioData 调用      :', R.decode);
console.log('  createBufferSource 调用   :', R.bufSrc);
console.log('  source.start() 调用       :', R.started);
console.log('  点击过的按钮数            :', R.buttonsClicked, '+', R.extraClicked);
console.log();
console.log('=== audio.status() ===');
console.log(' ', JSON.stringify(R.status));
console.log();
console.log('=== 页面报错 ===');
console.log(' ', R.errs.length ? R.errs.slice(0, 8) : '无');

const pass = R.decode > 0 && R.bufSrc > 0 && R.started > 0 && R.errs.length === 0;
console.log();
console.log(pass
  ? `✓ 采样链路通：解码 ${R.decode} 次、建源 ${R.bufSrc} 次、发声 ${R.started} 次`
  : '✗ 采样链路有问题');
process.exit(pass ? 0 : 1);
