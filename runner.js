/**
 * CLI 闭环验证 —— 用来证明「输入 → 管线 → 状态变化 → 新选项」整条链路跑得通。
 *
 * 这不是最终交付品。最终交付是第 7 期的单文件 HTML。
 * CLI 的作用是：比 UI 快十倍地暴露引擎问题，且出错时定位精确。
 *
 * 用法：node runner.js
 */

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createDemoWorld, createDemoState, CLUES, PLACES, SLOT_LABELS } from './data/demo.js';
import { nextTurn, applyTurn, buildView, TurnRejected } from './src/engine.js';
import { createStore, formatChanges, hashState } from './src/state.js';
import { exportStore, importToStore, SaveError } from './src/save.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVE_PATH = join(HERE, 'save-slot-1.json');

const LINE = '─'.repeat(58);

function place(id) {
  return PLACES[id] ?? id ?? '未知';
}

function panel(view) {
  const out = [];
  out.push(LINE);
  out.push(` 第 ${view.clock.day} 天 · ${view.clock.label} ｜ ${place(view.where)}`);
  out.push(LINE);

  for (const a of view.actors) {
    const met = a.met ? '' : '（未见面）';
    const stats = a.stats.map(s => `${s.key} ${s.value}`).join('  ');
    out.push(` ${a.name}${met}  路线:${a.route}`);
    out.push(`   ${stats}`);
  }

  if (view.clues.length > 0) {
    const names = view.clues.map(id => CLUES[id] ?? id);
    out.push(` 线索(${names.length}): ${names.join(' / ')}`);
  }
  if (view.achievements.length > 0) {
    out.push(` 成就: ${view.achievements.join(' ')}`);
  }
  out.push(LINE);
  return out.join('\n');
}

function showOptions(options) {
  const lines = [' 你要怎么做？'];
  options.forEach((o, i) => {
    const mark = o.available ? ' ' : '×';
    const key = o.key.length === 1 ? o.key : `[${o.key}]`;
    let text = `  ${mark} ${i + 1}. ${key}  ${o.label}`;
    if (!o.available) text += `   — ${o.reason}`;
    lines.push(text);
  });
  lines.push('  （输入序号或分支字母；q 退出 / s 存档 / l 读档 / r 回退一步 / h 帮助）');
  return lines.join('\n');
}

function showReport(report) {
  const out = [];
  out.push('');
  out.push(`【${report.eventTitle} · ${report.branchLabel}】`);
  if (report.text) out.push(report.text);
  if (report.firstMet?.length) out.push(`（首次出场：${report.firstMet.join(' / ')}）`);

  const changes = formatChanges(report.changes);
  if (changes.trim()) {
    out.push('');
    out.push(' 数值变化：');
    out.push(changes);
  }

  for (const a of report.achievements) {
    out.push('');
    out.push(` ※ 成就解锁：${a.title}（${a.id}）`);
  }
  if (report.ending) {
    out.push('');
    out.push(` ★ 结局：${report.ending.title}`);
  }
  return out.join('\n');
}

async function main() {
  const world = createDemoWorld();
  const store = createStore(createDemoState());

  stdout.write(`\n《旧楼一夜》— 引擎闭环验证\n（示例数据为中性题材，仅用于验证引擎）\n`);

  const rl = readline.createInterface({ input: stdin, output: stdout });

  // 非交互（管道/重定向）下不能用 rl.question：stdin 到达 EOF 后
  // 后续 question 既不 resolve 也不 reject，事件循环空转会让进程直接退出。
  // 改为用异步迭代器逐行消费，输入耗尽时当作退出指令。
  const feed = stdin.isTTY ? null : rl[Symbol.asyncIterator]();

  async function ask() {
    if (feed) {
      stdout.write(' > ');
      const { value, done } = await feed.next();
      if (done) return 'q';
      return String(value).trim();
    }
    return (await rl.question(' > ')).trim();
  }

  let turns = 0;

  try {
    while (true) {
      const state = store.getState();

      // 终结判定：已经走到结局就停
      if (state.endings.length > 0) {
        stdout.write(`\n${LINE}\n 本局结束，共 ${turns} 轮。\n 结局：${state.endings.join(' ')}\n${LINE}\n`);
        break;
      }

      const opened = nextTurn(state, world);
      if (hashState(opened.state) !== hashState(state)) {
        store.commit(opened.state);
        for (const skip of opened.skips) {
          stdout.write(` … 无事件，时间推进到 第 ${skip.day} 天 ${skip.slot}\n`);
        }
      }

      if (!opened.event) {
        stdout.write(`\n 没有可推进的事件了。共 ${turns} 轮。\n`);
        break;
      }

      const view = buildView(store.getState(), world, { options: opened.options });
      stdout.write(`\n${panel(view)}\n`);
      stdout.write(`${showOptions(opened.options)}\n`);

      const raw = await ask();
      if (raw === '') continue;

      if (raw === 'q') { stdout.write(' 已退出。\n'); break; }
      if (raw === 'h') {
        stdout.write([
          ' 输入序号（如 1）或分支字母（如 A）推进剧情。',
          ' s 存档到 save-slot-1.json ｜ l 从该文件读档 ｜ r 回退一步 ｜ q 退出',
        ].join('\n') + '\n');
        continue;
      }
      if (raw === 's') {
        writeFileSync(SAVE_PATH, exportStore(store, { title: '旧楼一夜', turns }), 'utf8');
        stdout.write(` 已存档：${SAVE_PATH}\n`);
        continue;
      }
      if (raw === 'l') {
        if (!existsSync(SAVE_PATH)) { stdout.write(' 没有找到存档文件。\n'); continue; }
        try {
          const { meta } = importToStore(store, readFileSync(SAVE_PATH, 'utf8'));
          turns = meta.turns ?? turns;
          stdout.write(' 读档完成。\n');
        } catch (e) {
          stdout.write(` 读档失败：${e instanceof SaveError ? e.message : e.message}\n`);
        }
        continue;
      }
      if (raw === 'r') {
        stdout.write(store.rollback(1) ? ' 已回退一步。\n' : ' 已经是最早的状态。\n');
        continue;
      }

      // 解析输入：序号或分支 key
      let chosen = null;
      if (/^\d+$/.test(raw)) {
        const idx = Number(raw) - 1;
        const opt = opened.options[idx];
        if (!opt) { stdout.write(' 没有这个序号。\n'); continue; }
        if (!opt.available) { stdout.write(` 这个选项现在不成立：${opt.reason}\n`); continue; }
        chosen = opt.key;
      } else {
        chosen = raw.toUpperCase();
      }

      try {
        const { state: after, report } = applyTurn(store.getState(), opened.event, chosen, world);
        store.commit(after);
        turns += 1;
        stdout.write(`${showReport(report)}\n`);
        if (report.terminal) {
          stdout.write(`\n${LINE}\n 本局结束，共 ${turns} 轮。\n${LINE}\n`);
          break;
        }
      } catch (e) {
        if (e instanceof TurnRejected) {
          stdout.write(` 这一步走不通：${e.message}\n`);
          continue;
        }
        throw e;
      }

      if (turns >= 60) {
        stdout.write('\n 达到 60 轮上限，自动结束（防止死循环）。\n');
        break;
      }
    }
  } finally {
    rl.close();
  }
}

main().catch(e => {
  console.error('运行出错：', e);
  process.exitCode = 1;
});
