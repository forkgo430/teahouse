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

  /* 关掉过渡再量尺寸。
     --dump-dom 不渲染帧，CSS transition 推不到终点（.ne-body 的
     grid-template-columns 有 0.22s 过渡，会一直停在起始值 0）——
     这是 headless 的伪影，不是产物的毛病。截图能看到书架，就是因为
     截图要渲染帧。要量最终布局，就得把过渡摘掉。 */
  const noAnim = document.createElement('style');
  noAnim.textContent = '* { transition: none !important; animation: none !important; }';
  document.head.appendChild(noAnim);

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

    // 玩法段：推进方式 / 群聊 / 玩家设定 —— 这三个开关是后来加的
    const modalText = (q('.ne-modal') || {}).innerText || '';
    for (const label of ['推进方式', '事件驱动', '自由对话', '群聊', '这一轮谁开口', '点名谁谁答', '谁可以不开口', '你（玩家）的名字', '你（玩家）的设定', '设定放在哪', '以什么身份发']) {
      if (!modalText.includes(label)) R.missing.push('设置面板缺「' + label + '」');
    }
  } else R.missing.push('.ne-icon-btn 设置');

  // ⑤ 右缘书架：打开，检查三本书的几何
  //    为什么查几何而不是「元素在不在」：书脊的 position 被别的规则抢走过
  //    （涟漪的 .has-ripple 与它同权重、位置更靠后），书脊于是从
  //    「左侧贯穿整条」塌成「顶部一小块」—— 元素一个不少，看着却是残的。
  //    先关掉上一步开着的弹窗，否则遮罩会把点击吃掉，书架压根打不开。
  for (const b of [...document.querySelectorAll('.ne-modal button')]) {
    if (b.textContent.trim() === '关闭') b.click();
  }
  await wait(400);
  if (q('.ne-modal')) {
    // 设置面板没有「关闭」按钮，用 Esc 关（与真人操作一致）
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(400);
  }
  R.notes.push('弹窗还在=' + !!q('.ne-modal'));

  const handle = q('.shelf-handle');
  if (!handle) R.missing.push('.shelf-handle（书架没有入口）');
  else {
    handle.click();
    await wait(900);

    const nb = q('.ne-body');
    const opened = nb && (nb.classList.contains('has-right') || nb.classList.contains('has-shelf'));
    if (!opened) {
      R.missing.push('点了把手但书架没打开（.ne-body 上没有 has-right / has-shelf）');
    }
    if (nb) {
      R.notes.push('ne-body列=' + getComputedStyle(nb).gridTemplateColumns);
      R.notes.push('ne-body类=' + nb.className.replace(/\\s+/g, ','));
    }
    const drw = q('.ne-drawer-right');
    if (drw) R.notes.push('抽屉=' + Math.round(drw.getBoundingClientRect().width) + ' display=' + getComputedStyle(drw).display);
    R.notes.push('视口=' + innerWidth + 'x' + innerHeight);

    const hcs = getComputedStyle(handle);
    if (hcs.position !== 'fixed') {
      R.missing.push('书架把手 position=' + hcs.position + '（应为 fixed，掉进文档流会浮在书本中间）');
    }

    // 世界书条目：点标题要能展开编辑面板（原先只能整份导入，没处改）
    const title = q('.book-entry-title');
    if (!title) {
      R.missing.push('.book-entry-title（世界书条目不能点开编辑）');
    } else {
      title.click();
      await wait(400);
      const edit = q('.book-entry-edit');
      if (!edit) {
        R.missing.push('点了条目标题但没展开编辑面板');
      } else {
        const et = edit.innerText || '';
        for (const label of ['标题', '关键词', '内容', '保存']) {
          if (!et.includes(label)) R.missing.push('编辑面板缺「' + label + '」');
        }
        // 再点一次应收起
        title.click();
        await wait(300);
        if (q('.book-entry-edit')) R.missing.push('再点标题没收起编辑面板');
      }
    }

    const books = document.querySelectorAll('.book');
    R.notes.push('书架=' + books.length + ' 本');
    if (books.length < 3) R.missing.push('.book 只有 ' + books.length + ' 本（人物 / 世界 / 成就）');

    books.forEach((bk, i) => {
      const sp = bk.querySelector('.book-spine');
      if (!sp) { R.missing.push('第 ' + (i + 1) + ' 本书没有书脊'); return; }
      const cs = getComputedStyle(sp);
      const sr = sp.getBoundingClientRect();
      const br = bk.getBoundingClientRect();

      if (cs.position !== 'absolute') {
        R.missing.push('第 ' + (i + 1) + ' 本书脊 position=' + cs.position + '（应为 absolute）');
      }
      // 书脊必须贯穿整本书 —— 这是「彩色布面完整呈现」的量化判据
      if (Math.abs(sr.height - br.height) > 2) {
        R.missing.push('第 ' + (i + 1) + ' 本书脊高 ' + Math.round(sr.height) + ' ≠ 书高 ' + Math.round(br.height) + '（没贯穿）');
      }
      if (sr.width < 28) R.missing.push('第 ' + (i + 1) + ' 本书脊只有 ' + Math.round(sr.width) + 'px 宽');
      if (br.width < 100) R.missing.push('第 ' + (i + 1) + ' 本书只有 ' + Math.round(br.width) + 'px 宽');

      // 图标与竖排书名必须上下分开（writing-mode 挂在书脊上会把轴向翻过去）
      const ic = sp.querySelector('.ic') || sp.querySelector('i');
      const tx = sp.querySelector('span');
      if (ic && tx) {
        const a = ic.getBoundingClientRect();
        const b = tx.getBoundingClientRect();
        const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlap > 0) {
          R.missing.push('第 ' + (i + 1) + ' 本书脊的图标与书名重叠 ' + Math.round(overlap) + 'px');
        }
      }
    });
  }
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
