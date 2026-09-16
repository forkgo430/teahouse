/**
 * 产物冒烟测试 —— 用系统 Chrome 把**打包后的单文件**跑一遍真实交互。
 *
 * 为什么需要它：`node --test` 跑的是源模块，喂的是 stub。
 * 「ui/app.js 忘了 import createWorld」这种错，449 项单测全绿也照不出来 ——
 * 症状是雨夜模式一按「体验模式」整页白屏，而单测压根没走 UI 装配。
 *
 * 这里走的是产物本身：注入错误钩子 → 真实点击 → 检查有没有报错、关键元素在不在。
 * 任一条不过就退出码 1。
 *
 * 用法：node tools/smoke.mjs        （先 node build.js）
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
  console.error('找不到浏览器，设 CHROME_PATH 环境变量');
  process.exit(2);
}
if (!existsSync(PRODUCT)) {
  console.error(`产物不存在：${PRODUCT} —— 先跑 node build.js`);
  process.exit(2);
}

/* ---------------------------------------------------------------- *
 * 注入脚本：跑完把结论写进 #SMOKE_OUT
 * ---------------------------------------------------------------- */

function makeProbe(mode) {
  return `
<script>
const R = { mode: '${mode}', errors: [], missing: [], notes: [] };
window.addEventListener('error', e => R.errors.push(e.message + ' @' + String(e.filename||'').split('/').pop() + ':' + e.lineno));
window.addEventListener('unhandledrejection', e => R.errors.push('unhandled rejection: ' + (e.reason?.message ?? e.reason)));
const _ce = console.error;
console.error = (...a) => { R.errors.push('console.error: ' + a.map(String).join(' ')); _ce(...a); };

const q = (s) => document.querySelector(s);
const need = (s, why) => { if (!q(s)) R.missing.push(s + ' （' + why + '）'); };
function clickText(sel, text) {
  const el = [...document.querySelectorAll(sel)].find(x => x.textContent.includes(text));
  if (!el) R.missing.push(sel + ' 含「' + text + '」');
  else el.click();
  return el;
}
function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
 try {
  try { localStorage.setItem('ne.mode', '${mode}'); } catch {}
  await wait(600);

  // ① 启动页
  need('.scene-boot', '启动页没渲染');
  need('.boot-item', '启动入口没有');

  // ② 进主界面
  clickText('.boot-item', '体验模式');
  await wait(1400);
  need('.ne-msg, .ne-stream', '主界面没渲染');

  const badge = q('.mode-badge');
  R.notes.push('模式徽章=' + (badge ? badge.textContent.trim() : '无'));
  R.notes.push('body.class=' + (document.body.className || '(空)'));
  R.notes.push('角色数=' + document.querySelectorAll('.ne-actor').length);
  R.notes.push('时间=' + ((q('.ne-clockbox') || {}).innerText || '无').replace(/\\s+/g, ' ').trim());

  // 主题类必须真的落在 body 上 —— 漏了的话雨夜模式顶着浅色主题跑
  const wantClass = '${mode}' === 'rainnight';
  if (wantClass !== document.body.classList.contains('mode-rainnight')) {
    R.missing.push('body.mode-rainnight（模式与主题类不一致）');
  }
  // 雨夜模式的招牌：当轮意愿与边界卡。样式一直在，渲染漏过一次。
  if (wantClass) {
    need('.consent-card', '雨夜模式的当轮意愿卡没渲染');
    R.notes.push('意愿卡按钮数=' + document.querySelectorAll('.consent-actions .book-tab').length);
  } else if (q('.consent-card')) {
    R.missing.push('.consent-card（茶馆标准不该出现意愿卡）');
  }

  // ③ 推三轮
  for (let i = 0; i < 3; i++) {
    const btn = [...document.querySelectorAll('button')].find(b => /^(继续|下一|推进|开\\s*茶)$/.test(b.textContent.trim()));
    const choice = q('.ne-choice');
    if (choice) choice.click(); else if (btn) btn.click();
    else { R.notes.push('第' + (i+1) + '轮没有可点的推进控件'); break; }
    await wait(800);
  }
  R.notes.push('推进后消息数=' + document.querySelectorAll('.ne-msg').length);

  // ④ 顶栏三个按钮：导入 / 设置
  const imp = [...document.querySelectorAll('.ne-icon-btn')].find(b => b.textContent.includes('导入'));
  if (imp) {
    imp.click();
    await wait(700);
    need('.ne-modal', '导入面板没弹出');
    R.notes.push('导入分区数=' + document.querySelectorAll('.import-cat').length);
    // 粘一份世界书，看解析链路是否活着
    const area = q('.ne-modal textarea');
    if (area) {
      area.value = JSON.stringify({ name: '冒烟', entries: { 0: { uid: 0, key: ['x'], content: '正文', order: 1 } } });
      fire(area, 'input');
      await wait(300);
      R.notes.push('导入预览=' + ((q('.ne-import-preview') || {}).innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80));
    } else R.missing.push('.ne-modal textarea （导入面板没有粘贴框）');
    const close = [...document.querySelectorAll('.ne-modal button')].find(b => b.textContent.trim() === '关闭');
    if (close) close.click();
    await wait(400);
  } else R.missing.push('.ne-icon-btn 含「导入」');

  const gear = [...document.querySelectorAll('.ne-icon-btn')].find(b => /设置|⚙/.test(b.textContent));
  if (gear) {
    gear.click();
    await wait(700);
    need('.ne-modal', '设置面板没弹出');
  } else R.missing.push('.ne-icon-btn 设置');

  // ⑤ 右缘书架
  const book = q('.book, .ne-book');
  R.notes.push('书架=' + (book ? '有' : '无'));
} catch (err) {
  R.errors.push('probe 自身出错：' + err.message);
} finally {
  const out = document.createElement('pre');
  out.id = 'SMOKE_OUT';
  out.textContent = JSON.stringify(R);
  document.body.appendChild(out);
  document.title = 'SMOKE_DONE';
}
}
run();
</script>
</html>`;
}

/* ---------------------------------------------------------------- *
 * 跑
 * ---------------------------------------------------------------- */

mkdirSync(TMP, { recursive: true });
const html = readFileSync(PRODUCT, 'utf8');
let failed = 0;

for (const mode of ['tea', 'rainnight']) {
  const file = join(TMP, `smoke-${mode}.html`);
  writeFileSync(file, html.replace('</html>', makeProbe(mode)), 'utf8');

  const res = spawnSync(chrome, [
    '--headless=new', '--disable-gpu',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=30000',
    '--window-size=1093,813',
    '--dump-dom',
    'file:///' + file.replace(/\\/g, '/'),
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  const dom = res.stdout ?? '';
  const m = dom.match(/<pre id="SMOKE_OUT">([\s\S]*?)<\/pre>/);
  if (!m) {
    console.log(`✗ [${mode}] 注入脚本没跑完（页面可能提前崩了）`);
    const errLine = dom.match(/ERROR[^<\n]{0,200}/);
    if (errLine) console.log('   ' + errLine[0]);
    failed += 1;
    continue;
  }

  // <pre> 里的 JSON 被 HTML 转义了
  const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  let R;
  try {
    R = JSON.parse(raw);
  } catch (e) {
    console.log(`✗ [${mode}] 结果不是合法 JSON：${e.message}`);
    failed += 1;
    continue;
  }

  const ok = R.errors.length === 0 && R.missing.length === 0;
  console.log(`${ok ? '✓' : '✗'} [${mode}] ${R.notes.join(' | ')}`);
  for (const e of R.errors) console.log('   报错：' + e);
  for (const e of R.missing) console.log('   缺元素：' + e);
  if (!ok) failed += 1;
}

console.log(failed === 0 ? '\n冒烟通过：两种模式都能进主界面、能推进、面板能开，全程无报错' : `\n冒烟失败：${failed} / 2`);
process.exit(failed === 0 ? 0 : 1);
