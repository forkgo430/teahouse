/**
 * 集成测试 —— 用中性示例数据把整条链路跑通。
 *
 * 单测验证零件，这里验证装配：真实数据 + 完整路线 + 存档往返 + 确定性。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTORS,
  EVENTS,
  ACHIEVEMENTS,
  ENDINGS,
  CLUES,
  createDemoWorld,
  createDemoState,
} from '../data/demo.js';
import { validateEventSet } from '../src/schema.js';
import { nextTurn, applyTurn, buildView, TurnRejected } from '../src/engine.js';
import { createStore, hashState } from '../src/state.js';
import { exportState, importState, exportStore, importToStore } from '../src/save.js';

/* ---------------------------------------------------------------- *
 * 自动玩家
 * ---------------------------------------------------------------- */

function autoplay(pick, maxTurns = 40) {
  const world = createDemoWorld();
  let state = createDemoState();
  const path = [];
  const visited = new Set();

  for (let i = 0; i < maxTurns; i++) {
    if (state.endings.length > 0) break;

    const opened = nextTurn(state, world);
    if (!opened.event) break;
    state = opened.state;

    const usable = opened.options.filter(o => o.available);
    if (usable.length === 0) break;

    const opt = pick(usable, opened, i) ?? usable[0];
    const { state: after, report } = applyTurn(state, opened.event, opt.key, world);

    state = after;
    visited.add(opened.event.id);
    path.push(`${opened.event.id}:${opt.key}`);
    if (report.terminal) break;
  }

  return { state, path, visited, world };
}

const firstAvailable = (usable) => usable[0];
const lastAvailable = (usable) => usable[usable.length - 1];

/* ---------------------------------------------------------------- *
 * 数据合法性
 * ---------------------------------------------------------------- */

test('示例事件集通过契约校验', () => {
  const { ok, issues } = validateEventSet(EVENTS);
  assert.equal(ok, true, `校验不通过：${JSON.stringify(issues, null, 2)}`);
});

test('createDemoWorld 可正常构造', () => {
  const world = createDemoWorld();
  assert.equal(world.events.length, EVENTS.length);
  assert.equal(world.achievements.length, ACHIEVEMENTS.length);
  assert.equal(world.endings.length, ENDINGS.length);
  assert.equal(world.slotLabels.night, '深夜');
});

test('createDemoState 数值落在边界内', () => {
  const s = createDemoState();
  for (const a of ACTORS) {
    for (const spec of a.stats) {
      const v = s.actors[a.id].stats[spec.key];
      assert.ok(v >= spec.min && v <= spec.max, `${a.id}.${spec.key} = ${v} 越界`);
    }
  }
  assert.equal(s.where, 'room');
  assert.equal(s.clock.slot, 'night');
});

test('线索表覆盖数据里用到的全部线索 id', () => {
  const used = new Set();
  for (const ev of EVENTS) {
    for (const b of ev.branches) {
      for (const eff of b.effects ?? []) {
        if (eff.path === 'clues' && eff.op === 'push') used.add(eff.value);
      }
      if (b.unlock?.clue) used.add(b.unlock.clue);
    }
  }
  for (const id of used) {
    assert.ok(CLUES[id], `线索 ${id} 没有在 CLUES 里定义名字`);
  }
});

test('每个事件都有可用的自动回落路径', () => {
  for (const ev of EVENTS) {
    const hasFallback = ev.fallback !== undefined;
    const hasUncond = ev.branches.some(b => (b.cond ?? null) === null);
    assert.ok(hasFallback || hasUncond, `${ev.id} 既无 fallback 也无无条件分支，可能卡死`);
  }
});

/* ---------------------------------------------------------------- *
 * 路线可达性
 * ---------------------------------------------------------------- */

test('全线选第一个可用项能走到结局', () => {
  const { state, path } = autoplay(firstAvailable);
  assert.ok(state.endings.length > 0, `没走到结局，路径：${path.join(' → ')}`);
  assert.equal(state.endings[0], 'END01');
  assert.ok(path.length >= 4, `轮数太少：${path.length}`);
});

test('全线选最后一个可用项能走到结局', () => {
  const { state, path } = autoplay(lastAvailable);
  assert.ok(state.endings.length > 0, `没走到结局，路径：${path.join(' → ')}`);
  assert.equal(state.endings[0], 'END03');
});

test('脚本路线能走到「留下来查清楚」结局', () => {
  const scripted = { E01: 'A', E02: 'A', E04: 'C', E05: 'A', E06: 'A', E07: 'B' };
  const { state, path } = autoplay((usable, opened) => usable.find(o => o.key === scripted[opened.event.id]));

  assert.deepEqual(path, ['E01:A', 'E02:A', 'E04:C', 'E05:A', 'E06:A', 'E07:B'], `实际路径：${path.join(' → ')}`);
  assert.deepEqual(state.endings, ['END02']);
  assert.equal(state.flags.stayed, true);
  assert.equal(state.clues.length >= 3, true, 'B 分支需要第三个线索');
});

test('同一路线两次运行状态指纹一致', () => {
  const run = () => hashState(autoplay(firstAvailable).state);
  const first = run();
  for (let i = 0; i < 4; i++) assert.equal(run(), first);
});

test('不同路线通向不同结局', () => {
  const a = autoplay(firstAvailable).state.endings[0];
  const b = autoplay(lastAvailable).state.endings[0];
  assert.notEqual(a, b);
});

/* ---------------------------------------------------------------- *
 * 运行期不变量
 * ---------------------------------------------------------------- */

test('全程数值始终落在声明边界内', () => {
  const world = createDemoWorld();
  let state = createDemoState();

  for (let i = 0; i < 30; i++) {
    const opened = nextTurn(state, world);
    if (!opened.event) break;
    state = opened.state;

    const usable = opened.options.filter(o => o.available);
    if (usable.length === 0) break;
    state = applyTurn(state, opened.event, usable[0], world).state;

    for (const actorId of Object.keys(state.actors)) {
      const actor = state.actors[actorId];
      for (const [key, value] of Object.entries(actor.stats)) {
        const bound = actor.bounds[key];
        assert.ok(Number.isFinite(value), `${actorId}.${key} 不是有限数字：${value}`);
        assert.ok(value >= bound.min && value <= bound.max,
          `第 ${i + 1} 轮后 ${actorId}.${key} = ${value} 越界 [${bound.min}, ${bound.max}]`);
      }
    }
    if (state.endings.length > 0) break;
  }
});

test('每一轮都留下历史记录且轮号连续', () => {
  const { state } = autoplay(firstAvailable);
  assert.ok(state.history.length > 0);
  state.history.forEach((h, i) => {
    assert.equal(h.turn, i + 1, '轮号应连续递增');
    assert.ok(h.eventId);
    assert.ok(h.branchKey);
    assert.ok(Number.isInteger(h.day));
  });
});

test('已触发事件不会重复出现（除非标了 repeat）', () => {
  const { state } = autoplay(firstAvailable);
  const ids = state.history.map(h => h.eventId);
  const repeatables = new Set(EVENTS.filter(e => e.repeat === true).map(e => e.id));
  const seen = new Set();
  for (const id of ids) {
    if (repeatables.has(id)) continue;
    assert.ok(!seen.has(id), `事件 ${id} 被重复触发`);
    seen.add(id);
  }
});

test('轮数与状态转移次数一致', () => {
  const world = createDemoWorld();
  const store = createStore(createDemoState());
  let turns = 0;

  for (let i = 0; i < 40; i++) {
    const state = store.getState();
    if (state.endings.length > 0) break;

    const opened = nextTurn(state, world);
    if (hashState(opened.state) !== hashState(state)) store.commit(opened.state);
    if (!opened.event) break;

    const usable = opened.options.filter(o => o.available);
    if (usable.length === 0) break;

    store.commit(applyTurn(store.getState(), opened.event, usable[0], world).state);
    turns += 1;
  }

  assert.equal(store.getState().history.length, turns);
  assert.ok(store.depth() >= turns, '每次提交都应留下快照');
});

/* ---------------------------------------------------------------- *
 * 存档
 * ---------------------------------------------------------------- */

test('走到中局存档 → 读档 → 继续走，结果一致', () => {
  const world = createDemoWorld();

  const play = (state, stop) => {
    let cur = state;
    for (let i = 0; i < stop; i++) {
      const opened = nextTurn(cur, world);
      if (!opened.event) break;
      cur = opened.state;
      const usable = opened.options.filter(o => o.available);
      if (usable.length === 0) break;
      cur = applyTurn(cur, opened.event, usable[0], world).state;
      if (cur.endings.length > 0) break;
    }
    return cur;
  };

  const mid = play(createDemoState(), 2);
  assert.equal(mid.history.length, 2);

  const text = exportState(mid, { title: '中局' });
  const { state: reloaded } = importState(text);
  assert.equal(hashState(reloaded), hashState(mid), '读档后状态应逐字节一致');

  const fromReload = play(reloaded, 20).endings[0];
  const fromLive = play(mid, 20).endings[0];
  assert.equal(fromReload, fromLive, '从中局继续应得到同一结局');
});

test('存档 → 读档 → 再存档，两次文本一致', () => {
  const { state } = autoplay(firstAvailable);
  const opts = { now: '2026-01-01T00:00:00.000Z' };
  const text1 = exportState(state, { title: 'X' }, opts);
  const reloaded = importState(text1).state;
  const text2 = exportState(reloaded, { title: 'X' }, { ...opts, createdAt: opts.now });
  assert.equal(text1, text2);
});

test('带时间线的存档能恢复回档能力', () => {
  const world = createDemoWorld();
  const store = createStore(createDemoState());

  for (let i = 0; i < 3; i++) {
    const opened = nextTurn(store.getState(), world);
    if (!opened.event) break;
    if (hashState(opened.state) !== hashState(store.getState())) store.commit(opened.state);
    const usable = opened.options.filter(o => o.available);
    if (usable.length === 0) break;
    store.commit(applyTurn(store.getState(), opened.event, usable[0], world).state);
  }

  const text = exportStore(store, { title: '带时间线' });
  const fresh = createStore(createDemoState());
  importToStore(fresh, text);

  assert.equal(hashState(fresh.getState()), hashState(store.getState()));
  assert.ok(fresh.depth() >= 3);
  assert.equal(fresh.rollback(1), true);
});

/* ---------------------------------------------------------------- *
 * 视图
 * ---------------------------------------------------------------- */

test('buildView 输出能直接渲染的结构', () => {
  const world = createDemoWorld();
  const state = createDemoState();
  const opened = nextTurn(state, world);
  const view = buildView(opened.state, world, { options: opened.options });

  assert.equal(view.clock.label, '深夜');
  assert.equal(view.where, 'room');
  assert.equal(view.actors.length, ACTORS.length);
  assert.ok(view.options.length >= 2);
  const opt = view.options[0];
  assert.ok('key' in opt && 'label' in opt && 'available' in opt);
});

/* ---------------------------------------------------------------- *
 * 错误路径
 * ---------------------------------------------------------------- */

test('非法分支 key 被拒绝且不改变状态', () => {
  const world = createDemoWorld();
  const state = createDemoState();
  const opened = nextTurn(state, world);
  const before = hashState(opened.state);

  assert.throws(() => applyTurn(opened.state, opened.event, 'ZZZ', world), TurnRejected);
  assert.equal(hashState(opened.state), before);
});

test('条件不满足的分支无法强行进入', () => {
  const world = createDemoWorld();
  // 第一天深夜，clues 为空 → E07 的 B 分支（需要第三个线索）不可用
  const state = createDemoState({
    // 直接构造到第三天夜里
  });
  const s3 = {
    ...state,
    clock: { day: 3, slot: 'night' },
  };
  const opened = nextTurn(s3, world);
  assert.equal(opened.event.id, 'E07');

  const b = opened.options.find(o => o.key === 'B');
  assert.equal(b.available, false);
  assert.throws(() => applyTurn(s3, opened.event, 'B', world), (e) => {
    assert.ok(e instanceof TurnRejected);
    assert.equal(e.detail.reason, 'condition-unmet');
    return true;
  });
});
