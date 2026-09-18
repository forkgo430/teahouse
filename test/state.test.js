import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState } from '../src/schema.js';
import {
  StateError,
  cloneState,
  applyEffectInPlace,
  applyEffects,
  stepDownRoute,
  stableStringify,
  hashState,
  formatChanges,
  createStore,
  ROUTE_STEP_DOWN,
} from '../src/state.js';

/* ---------------------------------------------------------------- *
 * 夹具
 * ---------------------------------------------------------------- */

function baseState() {
  return createInitialState({
    actors: [
      { id: 'lin', name: '林', stats: [
        { key: 'trust', min: 0, max: 100, init: 30 },
        { key: 'stress', min: 0, max: 100, init: 70 },
        { key: 'poise', min: 1, max: 5, init: 3 },
      ] },
      { id: 'ning', name: '宁', stats: [
        { key: 'trust', min: 0, max: 100, init: 20 },
      ] },
    ],
    clock: { day: 1, slot: 'night' },
    where: 'entrance',
    ledger: { cash: 100, income: 0, expense: 0 },
  });
}

const findChange = (changes, path) => changes.find(c => c.path === path);

/* ---------------------------------------------------------------- *
 * 不可变性
 * ---------------------------------------------------------------- */

test('applyEffects 不修改原状态', () => {
  const s = baseState();
  const before = JSON.stringify(s);
  applyEffects(s, [{ path: 'actors.lin.stats.trust', op: 'add', value: 10 }]);
  assert.equal(JSON.stringify(s), before);
});

test('applyEffects 返回全新对象（浅层引用也不同）', () => {
  const s = baseState();
  const { state: next } = applyEffects(s, [{ path: 'where', op: 'set', value: 'room' }]);
  assert.notEqual(next, s);
  assert.notEqual(next.actors, s.actors);
  assert.equal(next.where, 'room');
  assert.equal(s.where, 'entrance');
});

/* ---------------------------------------------------------------- *
 * 基本操作符
 * ---------------------------------------------------------------- */

test('set / add / sub / mul', () => {
  const s = baseState();
  const { state: a } = applyEffects(s, [
    { path: 'where', op: 'set', value: 'corridor' },
    { path: 'actors.lin.stats.trust', op: 'add', value: 10 },
    { path: 'actors.lin.stats.stress', op: 'sub', value: 20 },
    { path: 'actors.lin.stats.poise', op: 'mul', value: 1.5 },
  ]);
  assert.equal(a.where, 'corridor');
  assert.equal(a.actors.lin.stats.trust, 40);
  assert.equal(a.actors.lin.stats.stress, 50);
  assert.equal(a.actors.lin.stats.poise, 4.5);
});

test('对未设置的普通字段做 add 视为从 0 起算', () => {
  const s = baseState();
  const { state: next } = applyEffects(s, [{ path: 'ledger.bonus', op: 'add', value: 5 }]);
  assert.equal(next.ledger.bonus, 5);
});

test('对未设置的声明式数值做 add 同样被拒（不能绕开边界声明）', () => {
  const s = baseState();
  assert.throws(
    () => applyEffects(s, [{ path: 'actors.ning.stats.jealousy', op: 'add', value: 5 }]),
    (e) => {
      assert.ok(e instanceof StateError);
      assert.match(e.message, /缺少边界声明/);
      return true;
    },
  );
});

test('未声明的数值写入被拒绝（不静默创建）', () => {
  const s = baseState();
  assert.throws(
    () => applyEffects(s, [{ path: 'actors.ning.stats.jealousy', op: 'set', value: 5 }]),
    (e) => {
      assert.ok(e instanceof StateError);
      assert.match(e.message, /缺少边界声明/);
      return true;
    },
  );
});

test('add 作用在非数值字段上抛错', () => {
  const s = baseState();
  assert.throws(() => applyEffects(s, [{ path: 'where', op: 'add', value: 1 }]), StateError);
});

test('add 作用在字符串上抛错', () => {
  const s = baseState();
  assert.throws(() => applyEffects(s, [{ path: 'actors.lin.name', op: 'add', value: 1 }]), (e) => {
    assert.match(e.message, /需要数值目标/);
    return true;
  });
});

test('路径父级不存在时抛错并带上路径', () => {
  const s = baseState();
  assert.throws(() => applyEffects(s, [{ path: 'nope.deep.path', op: 'set', value: 1 }]), (e) => {
    assert.match(e.message, /nope\.deep\.path/);
    return true;
  });
});

test('toggle 翻转布尔', () => {
  const s = baseState();
  const r1 = applyEffects(s, [{ path: 'flags.door', op: 'set', value: true }]);
  assert.equal(r1.state.flags.door, true);
  const r2 = applyEffects(r1.state, [{ path: 'flags.door', op: 'toggle' }]);
  assert.equal(r2.state.flags.door, false);
});

test('toggle 作用在数值上抛错（不隐式转布尔）', () => {
  const s = baseState();
  assert.throws(() => applyEffects(s, [{ path: 'actors.lin.stats.trust', op: 'toggle' }]), (e) => {
    assert.match(e.message, /需要布尔目标/);
    return true;
  });
});

/* ---------------------------------------------------------------- *
 * 数组操作
 * ---------------------------------------------------------------- */

test('push 追加且幂等', () => {
  const s = baseState();
  const r1 = applyEffects(s, [{ path: 'clues', op: 'push', value: 'C01' }]);
  assert.deepEqual(r1.state.clues, ['C01']);
  assert.equal(findChange(r1.changes, 'clues').skipped, undefined);

  const r2 = applyEffects(r1.state, [{ path: 'clues', op: 'push', value: 'C01' }]);
  assert.deepEqual(r2.state.clues, ['C01'], '不应产生第二个副本');
  assert.equal(findChange(r2.changes, 'clues').skipped, 'duplicate');
});

test('pull 移除元素', () => {
  const s = applyEffects(baseState(), [{ path: 'clues', op: 'push', value: 'C01' }]).state;
  const { state: next } = applyEffects(s, [{ path: 'clues', op: 'pull', value: 'C01' }]);
  assert.deepEqual(next.clues, []);
});

test('push 到非数组字段抛错', () => {
  assert.throws(() => applyEffects(baseState(), [{ path: 'where', op: 'push', value: 'x' }]), StateError);
});

/* ---------------------------------------------------------------- *
 * 数值 clamp
 * ---------------------------------------------------------------- */

test('超上限被夹紧并留下痕迹', () => {
  const s = baseState();
  const { state: next, changes } = applyEffects(s, [{ path: 'actors.lin.stats.trust', op: 'add', value: 999 }]);
  assert.equal(next.actors.lin.stats.trust, 100);
  const c = findChange(changes, 'actors.lin.stats.trust');
  assert.ok(c.clamped, '必须标记 clamped');
  assert.equal(c.clamped.raw, 1029);
  assert.equal(c.clamped.min, 0);
  assert.equal(c.clamped.max, 100);
});

test('超下限被夹紧', () => {
  const { state: next, changes } = applyEffects(baseState(), [{ path: 'actors.lin.stats.stress', op: 'sub', value: 500 }]);
  assert.equal(next.actors.lin.stats.stress, 0);
  assert.equal(findChange(changes, 'actors.lin.stats.stress').clamped.raw, -430);
});

test('非 0-100 区间的数值按各自边界夹紧', () => {
  const { state: next } = applyEffects(baseState(), [{ path: 'actors.lin.stats.poise', op: 'add', value: 10 }]);
  assert.equal(next.actors.lin.stats.poise, 5, 'poise 上限是 5');
});

test('clamp 效果按给定区间动作', () => {
  const s = applyEffects(baseState(), [{ path: 'actors.lin.stats.trust', op: 'set', value: 300 }]).state;
  assert.equal(s.actors.lin.stats.trust, 100, '写入时已夹紧');

  const { state: next, changes } = applyEffects(s, [{ path: 'actors.lin.stats.trust', op: 'clamp', value: { min: 0, max: 40 } }]);
  assert.equal(next.actors.lin.stats.trust, 40);
  assert.equal(findChange(changes, 'actors.lin.stats.trust').clamped.reason, 'clamp-effect');
});

test('数值写非数字结果被拒', () => {
  assert.throws(
    () => applyEffects(baseState(), [{ path: 'actors.lin.stats.trust', op: 'set', value: Number.NaN }]),
    (e) => {
      assert.match(e.message, /不是有限数字/);
      return true;
    },
  );
});

/* ---------------------------------------------------------------- *
 * 路线状态
 * ---------------------------------------------------------------- */

test('路线写入必须落在合法值域', () => {
  const s = baseState();
  const { state: next } = applyEffects(s, [{ path: 'routes.lin', op: 'set', value: 'open' }]);
  assert.equal(next.routes.lin, 'open');
  assert.throws(() => applyEffects(s, [{ path: 'routes.lin', op: 'set', value: '暧昧' }]), (e) => {
    assert.match(e.message, /路线状态非法/);
    return true;
  });
});

test('stepDownRoute 回退一格', () => {
  assert.equal(stepDownRoute('advancing'), 'open');
  assert.equal(stepDownRoute('open'), 'closed');
  assert.equal(stepDownRoute('frozen'), 'closed');
  assert.equal(stepDownRoute('closed'), 'closed');
  assert.equal(stepDownRoute('settled'), 'settled');
  assert.equal(stepDownRoute('乱写的'), 'closed');
  assert.deepEqual(Object.keys(ROUTE_STEP_DOWN).sort(), ['advancing', 'closed', 'frozen', 'open', 'settled']);
});

/* ---------------------------------------------------------------- *
 * 账本与时钟
 * ---------------------------------------------------------------- */

test('账本累加与时钟推进', () => {
  const { state: next } = applyEffects(baseState(), [
    { path: 'ledger.cash', op: 'sub', value: 30 },
    { path: 'ledger.expense', op: 'add', value: 30 },
    { path: 'clock.day', op: 'add', value: 1 },
    { path: 'clock.slot', op: 'set', value: 'morning' },
  ]);
  assert.equal(next.ledger.cash, 70);
  assert.equal(next.ledger.expense, 30);
  assert.equal(next.clock.day, 2);
  assert.equal(next.clock.slot, 'morning');
});

test('账本允许负数（不是声明式数值）', () => {
  const { state: next } = applyEffects(baseState(), [{ path: 'ledger.cash', op: 'sub', value: 500 }]);
  assert.equal(next.ledger.cash, -400);
});

/* ---------------------------------------------------------------- *
 * 稳定序列化与指纹
 * ---------------------------------------------------------------- */

test('stableStringify 与键序无关', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify({ x: [1, { z: 1, y: 2 }] }), stableStringify({ x: [1, { y: 2, z: 1 }] }));
});

test('stableStringify 区分不同类型', () => {
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: '1' }));
  assert.notEqual(stableStringify({ a: null }), stableStringify({ a: 0 }));
});

test('同状态指纹相同，异状态指纹不同', () => {
  const a = baseState();
  const b = baseState();
  assert.equal(hashState(a), hashState(b));

  const c = applyEffects(a, [{ path: 'where', op: 'set', value: 'roof' }]).state;
  assert.notEqual(hashState(a), hashState(c));
});

test('键序不同的等价状态指纹相同', () => {
  assert.equal(hashState({ a: 1, b: 2 }), hashState({ b: 2, a: 1 }));
});

/* ---------------------------------------------------------------- *
 * 确定性（核心验收项）
 * ---------------------------------------------------------------- */

test('同一状态 + 同一 effects 序列两次运行指纹一致', () => {
  const script = [
    [{ path: 'actors.lin.stats.trust', op: 'add', value: 25 }],
    [{ path: 'clues', op: 'push', value: 'C01' }, { path: 'flags.met', op: 'set', value: true }],
    [{ path: 'actors.lin.stats.stress', op: 'sub', value: 300 }],
    [{ path: 'routes.lin', op: 'set', value: 'open' }, { path: 'clock.day', op: 'add', value: 1 }],
  ];

  const run = () => {
    let s = baseState();
    for (const effs of script) s = applyEffects(s, effs).state;
    return hashState(s);
  };

  const first = run();
  for (let i = 0; i < 5; i++) {
    assert.equal(run(), first, `第 ${i + 2} 次运行结果应与首次一致`);
  }
});

test('splitPath 顺序无关：同样的效果顺序不同则结果可能不同（这是预期的）', () => {
  const a = applyEffects(baseState(), [
    { path: 'actors.lin.stats.trust', op: 'set', value: 50 },
    { path: 'actors.lin.stats.trust', op: 'add', value: 10 },
  ]).state.actors.lin.stats.trust;
  const b = applyEffects(baseState(), [
    { path: 'actors.lin.stats.trust', op: 'add', value: 10 },
    { path: 'actors.lin.stats.trust', op: 'set', value: 50 },
  ]).state.actors.lin.stats.trust;
  assert.equal(a, 60);
  assert.equal(b, 50);
});

/* ---------------------------------------------------------------- *
 * 日志格式
 * ---------------------------------------------------------------- */

test('formatChanges 输出可读文本并标出夹紧', () => {
  const { changes } = applyEffects(baseState(), [
    { path: 'actors.lin.stats.trust', op: 'add', value: 999 },
  ]);
  const text = formatChanges(changes);
  assert.match(text, /actors\.lin\.stats\.trust/);
  assert.match(text, /夹紧/);
});

test('formatChanges 对空 changes 返回空串', () => {
  assert.equal(formatChanges([]), '');
});

/* ---------------------------------------------------------------- *
 * Store
 * ---------------------------------------------------------------- */

test('store 初始快照为初始状态', () => {
  const store = createStore(baseState());
  assert.equal(store.depth(), 0);
  assert.equal(store.getState().where, 'entrance');
});

test('store.dispatch 推进状态并加深时间线', () => {
  const store = createStore(baseState());
  store.dispatch([{ path: 'where', op: 'set', value: 'room' }]);
  assert.equal(store.getState().where, 'room');
  assert.equal(store.depth(), 1);
  store.dispatch([{ path: 'where', op: 'set', value: 'roof' }]);
  assert.equal(store.depth(), 2);
});

test('store.rollback 回到上一轮', () => {
  const store = createStore(baseState());
  store.dispatch([{ path: 'where', op: 'set', value: 'room' }]);
  store.dispatch([{ path: 'where', op: 'set', value: 'roof' }]);
  assert.equal(store.rollback(1), true);
  assert.equal(store.getState().where, 'room');
  assert.equal(store.rollback(1), true);
  assert.equal(store.getState().where, 'entrance');
  assert.equal(store.rollback(1), false, '到底了应返回 false');
  assert.equal(store.getState().where, 'entrance');
});

test('store.rollback 拒绝非法步数', () => {
  const store = createStore(baseState());
  assert.throws(() => store.rollback(0), RangeError);
  assert.throws(() => store.rollback(-1), RangeError);
  assert.throws(() => store.rollback(1.5), RangeError);
});

test('store 的 getState 返回副本，改不动内部状态', () => {
  const store = createStore(baseState());
  const s = store.getState();
  s.where = '被改了';
  assert.equal(store.getState().where, 'entrance');
});

test('store.replace 重置时间线', () => {
  const store = createStore(baseState());
  store.dispatch([{ path: 'where', op: 'set', value: 'room' }]);
  store.replace(baseState());
  assert.equal(store.depth(), 0);
  assert.equal(store.getState().where, 'entrance');
});

test('store 时间线超过上限时丢弃最旧快照', () => {
  const store = createStore(baseState(), { maxSnapshots: 3 });
  store.dispatch([{ path: 'clock.day', op: 'add', value: 1 }]);
  store.dispatch([{ path: 'clock.day', op: 'add', value: 1 }]);
  store.dispatch([{ path: 'clock.day', op: 'add', value: 1 }]);
  assert.equal(store.depth(), 2, '保留最近 3 个快照');
  assert.equal(store.rollback(2), true);
  assert.equal(store.rollback(1), false);
});

/* ---------------------------------------------------------------- *
 * $auto 派生计数
 * ---------------------------------------------------------------- */

test('$auto.achievement_count 跟随 push achievement 更新', () => {
  const store = createStore(baseState());
  assert.equal(store.getState().$auto.achievement_count, 0);
  store.dispatch([{ path: 'achievements', op: 'push', value: 'A01' }]);
  assert.equal(store.getState().$auto.achievement_count, 1);
  store.dispatch([{ path: 'achievements', op: 'push', value: 'A02' }]);
  assert.equal(store.getState().$auto.achievement_count, 2);
});

test('rollback 之后 $auto.achievement_count 跟着回退', () => {
  const store = createStore(baseState());
  store.dispatch([{ path: 'achievements', op: 'push', value: 'A01' }]);
  store.dispatch([{ path: 'achievements', op: 'push', value: 'A02' }]);
  assert.equal(store.getState().$auto.achievement_count, 2);
  assert.equal(store.rollback(1), true);
  assert.equal(store.getState().achievements.length, 1);
  assert.equal(store.getState().$auto.achievement_count, 1, '派生值必须跟着回退，不能沿用当前值');
  assert.equal(store.rollback(1), true);
  assert.equal(store.getState().$auto.achievement_count, 0);
});

test('replace 之后 $auto 从新状态重算', () => {
  const store = createStore(baseState());
  store.dispatch([{ path: 'achievements', op: 'push', value: 'A01' }]);
  assert.equal(store.getState().$auto.achievement_count, 1);
  const other = baseState();
  other.achievements = ['A01', 'A02', 'A03'];
  store.replace(other);
  assert.equal(store.getState().$auto.achievement_count, 3, '必须从替换后的数组重算');
  assert.equal(store.depth(), 0);
});

test('commit 之后 $auto 也从新状态重算', () => {
  const store = createStore(baseState());
  const next = baseState();
  next.achievements = ['A01', 'A02'];
  store.commit(next);
  assert.equal(store.getState().$auto.achievement_count, 2);
  assert.equal(store.depth(), 1, 'commit 要留快照');
});

/* ---------------------------------------------------------------- *
 * 边界
 * ---------------------------------------------------------------- */

test('空 effects 返回等价状态且无 changes', () => {
  const s = baseState();
  const { state: next, changes } = applyEffects(s, []);
  assert.deepEqual(changes, []);
  assert.equal(hashState(next), hashState(s));
});

test('cloneState 是真深拷贝', () => {
  const s = baseState();
  const c = cloneState(s);
  c.actors.lin.stats.trust = 999;
  c.clues.push('X');
  assert.equal(s.actors.lin.stats.trust, 30);
  assert.deepEqual(s.clues, []);
});

test('applyEffectInPlace 可直接作用于已克隆对象', () => {
  const s = cloneState(baseState());
  const change = applyEffectInPlace(s, { path: 'flags.k', op: 'set', value: 1 });
  assert.equal(s.flags.k, 1);
  assert.equal(change.from, undefined);
  assert.equal(change.to, 1);
});
