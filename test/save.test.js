import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState } from '../src/schema.js';
import { createStore, hashState } from '../src/state.js';
import {
  SAVE_FORMAT,
  SAVE_VERSION,
  SaveError,
  validateSaveShape,
  migrate,
  makeSave,
  serialize,
  deserialize,
  exportState,
  importState,
  exportStore,
  importToStore,
  describeSave,
} from '../src/save.js';

/* ---------------------------------------------------------------- *
 * 夹具
 * ---------------------------------------------------------------- */

function stateFixture(overrides = {}) {
  const s = createInitialState({
    actors: [
      { id: 'keeper', name: '管理员', stats: [
        { key: 'trust', min: 0, max: 100, init: 20 },
        { key: 'guard', min: 0, max: 100, init: 60 },
      ] },
      { id: 'neighbor', name: '邻居', stats: [{ key: 'trust', min: 0, max: 100, init: 10 }] },
    ],
    clock: { day: 1, slot: 'night' },
    where: 'room',
    ledger: { cash: 5000, income: 0, expense: 0 },
  });
  return { ...s, ...overrides };
}

const sampleSave = () => makeSave(stateFixture(), { title: '测试存档' }, { now: '2026-09-16T09:00:00.000Z' });

/* ---------------------------------------------------------------- *
 * 构造与形状
 * ---------------------------------------------------------------- */

test('makeSave 产出完整结构', () => {
  const save = sampleSave();
  assert.equal(save.format, SAVE_FORMAT);
  assert.equal(save.version, SAVE_VERSION);
  assert.equal(save.createdAt, '2026-09-16T09:00:00.000Z');
  assert.equal(save.updatedAt, '2026-09-16T09:00:00.000Z');
  assert.equal(typeof save.stateHash, 'string');
  assert.equal(save.meta.title, '测试存档');
  assert.equal(save.state.clock.slot, 'night');
  assert.equal(save.timeline, undefined, '默认不带时间线');
});

test('makeSave 的 state 是深拷贝', () => {
  const s = stateFixture();
  const save = makeSave(s);
  save.state.actors.keeper.stats.trust = 999;
  assert.equal(s.actors.keeper.stats.trust, 20);
});

test('makeSave 可以带时间线', () => {
  const s = stateFixture();
  const save = makeSave(s, {}, { timeline: [s, s] });
  assert.equal(save.timeline.length, 2);
});

test('makeSave 可以裁掉 history', () => {
  const s = stateFixture({ history: [{ turn: 1, eventId: 'E01', branchKey: 'A' }] });
  const save = makeSave(s, {}, { includeHistory: false });
  assert.deepEqual(save.state.history, [], '存档体量可压缩');
});

test('makeSave 拒绝非对象 state', () => {
  assert.throws(() => makeSave(null), SaveError);
  assert.throws(() => makeSave('x'), SaveError);
});

test('validateSaveShape 逐项报错', () => {
  assert.deepEqual(validateSaveShape('nope'), ['存档根节点必须是对象']);

  const bad = { format: 'wrong', version: -1, state: { clock: { day: 'x' } } };
  const issues = validateSaveShape(bad);
  assert.ok(issues.some(i => /format/.test(i)));
  assert.ok(issues.some(i => /version/.test(i)));
  assert.ok(issues.some(i => /clock\.day/.test(i)));
  assert.ok(issues.some(i => /actors/.test(i)));
  assert.ok(issues.some(i => /history/.test(i)));
});

test('合法存档无问题项', () => {
  assert.deepEqual(validateSaveShape(sampleSave()), []);
});

/* ---------------------------------------------------------------- *
 * 往返（核心验收项）
 * ---------------------------------------------------------------- */

test('序列化 → 反序列化后状态逐字段相等', () => {
  const s = stateFixture({
    clues: ['C01', 'C02'],
    flags: { door: true },
    achievements: ['A01'],
    history: [{ turn: 1, eventId: 'E01', branchKey: 'A', day: 1, slot: 'night', where: 'room', changes: [] }],
  });
  const text = exportState(s, { title: '往返' });
  const { state: back, meta } = importState(text);

  assert.deepEqual(back, s);
  assert.equal(hashState(back), hashState(s));
  assert.equal(meta.title, '往返');
});

test('两次序列化同一状态产出相同文本', () => {
  const s = stateFixture();
  const opts = { now: '2026-01-01T00:00:00.000Z' };
  assert.equal(exportState(s, {}, opts), exportState(s, {}, opts));
});

test('serialize 默认美化输出，可关闭', () => {
  const save = sampleSave();
  assert.ok(serialize(save).includes('\n  '));
  const compact = serialize(save, { pretty: false });
  assert.ok(!compact.includes('\n  '));
  assert.deepEqual(deserialize(compact).state, save.state);
});

test('serialize 对非法结构抛错', () => {
  assert.throws(() => serialize({ format: 'x', version: 1, state: {} }), (e) => {
    assert.ok(e instanceof SaveError);
    assert.match(e.message, /结构不合法/);
    return true;
  });
});

/* ---------------------------------------------------------------- *
 * 完整性
 * ---------------------------------------------------------------- */

test('存档被手工改动后校验和不符并报错', () => {
  const save = sampleSave();
  save.state.actors.keeper.stats.trust = 99;
  assert.throws(() => deserialize(JSON.stringify(save)), (e) => {
    assert.ok(e instanceof SaveError);
    assert.match(e.message, /校验和不符/);
    assert.equal(e.detail.expected, save.stateHash);
    return true;
  });
});

test('可以显式跳过校验和（用于调试）', () => {
  const save = sampleSave();
  save.state.actors.keeper.stats.trust = 99;
  const out = deserialize(JSON.stringify(save), { verifyHash: false });
  assert.equal(out.state.actors.keeper.stats.trust, 99);
});

test('空内容与非 JSON 被拒', () => {
  assert.throws(() => deserialize(''), (e) => {
    assert.match(e.message, /为空/);
    return true;
  });
  assert.throws(() => deserialize('   '), SaveError);
  assert.throws(() => deserialize('{坏的'), (e) => {
    assert.match(e.message, /不是合法 JSON/);
    return true;
  });
});

/* ---------------------------------------------------------------- *
 * 迁移
 * ---------------------------------------------------------------- */

const v0Save = () => ({
  format: SAVE_FORMAT,
  version: 0,
  state: {
    clock: { day: 1, slot: 'night' },
    actors: {},
    history: [],
    ledger: { cash: 10 },
  },
});

const v0Migration = {
  0: (s) => ({
    ...s,
    version: 1,
    state: { ...s.state, ledger: { income: 0, expense: 0, ...s.state.ledger } },
  }),
};

test('同版本存档原样通过', () => {
  const save = sampleSave();
  assert.equal(migrate(save).version, SAVE_VERSION);
});

test('无迁移函数时明确报错并指出卡在哪一版', () => {
  assert.throws(() => migrate(v0Save()), (e) => {
    assert.ok(e instanceof SaveError);
    assert.match(e.message, /缺少 v0 → v1 的迁移函数/);
    assert.equal(e.detail.stuckAt, 0);
    return true;
  });
});

test('有迁移函数时逐级升级并补齐字段', () => {
  const out = migrate(v0Save(), v0Migration);
  assert.equal(out.version, 1);
  assert.equal(out.state.ledger.cash, 10, '原有字段保留');
  assert.equal(out.state.ledger.income, 0, '新字段补齐');
});

test('多级迁移按顺序链式执行', () => {
  const chain = {
    0: (s) => ({ ...s, version: 1, tags: ['a'] }),
    1: (s) => ({ ...s, version: 2, tags: [...s.tags, 'b'] }),
    2: (s) => ({ ...s, version: 3, tags: [...s.tags, 'c'] }),
  };
  const out = migrate(v0Save(), chain, 3);
  assert.equal(out.version, 3);
  assert.deepEqual(out.tags, ['a', 'b', 'c']);
});

test('迁移函数没有推进版本号时报错', () => {
  const broken = { 0: (s) => ({ ...s, version: 0 }) };
  assert.throws(() => migrate(v0Save(), broken), (e) => {
    assert.match(e.message, /没有把 version 推进到 v1/);
    return true;
  });
});

test('迁移函数返回非对象时报错', () => {
  const broken = { 0: () => null };
  assert.throws(() => migrate(v0Save(), broken), SaveError);
});

test('未来版本的存档被拒并提示升级程序', () => {
  const future = { ...sampleSave(), version: SAVE_VERSION + 5 };
  assert.throws(() => migrate(future), (e) => {
    assert.match(e.message, /高于当前程序支持的/);
    return true;
  });
});

test('version 非整数时报错', () => {
  assert.throws(() => migrate({ ...sampleSave(), version: 'v1' }), (e) => {
    assert.match(e.message, /version 非法/);
    return true;
  });
});

test('deserialize 支持传入自定义迁移表', () => {
  const text = JSON.stringify(v0Save());
  const out = deserialize(text, { migrations: v0Migration, verifyHash: false });
  assert.equal(out.version, 1);
  assert.equal(out.state.ledger.income, 0);
});

test('deserialize 遇到无法迁移的旧存档时报错而非猜测', () => {
  assert.throws(() => deserialize(JSON.stringify(v0Save())), (e) => {
    assert.match(e.message, /缺少 v0 → v1/);
    return true;
  });
});

/* ---------------------------------------------------------------- *
 * 与 store 集成
 * ---------------------------------------------------------------- */

test('exportStore / importToStore 恢复状态与时间线', () => {
  const store = createStore(stateFixture());
  store.dispatch([{ path: 'where', op: 'set', value: 'corridor' }]);
  store.dispatch([{ path: 'where', op: 'set', value: 'roof' }]);
  store.dispatch([{ path: 'actors.keeper.stats.trust', op: 'add', value: 30 }]);

  const text = exportStore(store, { title: '带时间线' });
  const expectedHash = hashState(store.getState());
  const expectedDepth = store.depth();

  const fresh = createStore(stateFixture());
  const { meta } = importToStore(fresh, text);

  assert.equal(hashState(fresh.getState()), expectedHash);
  assert.equal(fresh.depth(), expectedDepth, '回档能力一并恢复');
  assert.equal(meta.title, '带时间线');

  assert.equal(fresh.rollback(1), true);
  assert.equal(fresh.getState().where, 'roof', '回退到上一轮（第 3 步 → 第 2 步）');
  assert.equal(fresh.rollback(1), true);
  assert.equal(fresh.getState().where, 'corridor', '再退一轮');
  assert.equal(fresh.rollback(1), true);
  assert.equal(fresh.getState().where, 'room', '退到初始状态');
  assert.equal(fresh.rollback(1), false, '到底了');
});

test('importToStore 不带时间线时重置为单点', () => {
  const store = createStore(stateFixture());
  store.dispatch([{ path: 'where', op: 'set', value: 'corridor' }]);

  const text = exportState(store.getState(), {});
  const fresh = createStore(stateFixture());
  importToStore(fresh, text);

  assert.equal(fresh.depth(), 0);
  assert.equal(fresh.rollback(1), false);
});

test('store.replace 显式传时间线也能恢复', () => {
  const store = createStore(stateFixture());
  store.dispatch([{ path: 'where', op: 'set', value: 'corridor' }]);
  const snaps = store.allSnapshots();

  const other = createStore(stateFixture());
  other.dispatch([{ path: 'where', op: 'set', value: 'roof' }]);
  other.replace(snaps[snaps.length - 1], snaps);

  assert.equal(other.getState().where, 'corridor');
  assert.equal(other.depth(), 1);
});

/* ---------------------------------------------------------------- *
 * 摘要
 * ---------------------------------------------------------------- */

test('describeSave 给出可读摘要', () => {
  const s = stateFixture({
    history: [{ turn: 1, eventId: 'E01', branchKey: 'A', day: 1, slot: 'night', where: 'room', changes: [] }],
    achievements: ['A01'],
    endings: ['END01'],
  });
  const save = makeSave(s, { title: '摘要' }, { timeline: [s, s] });
  const d = describeSave(save);

  assert.equal(d.turn, 1);
  assert.equal(d.day, 1);
  assert.equal(d.slot, 'night');
  assert.equal(d.achievements, 1);
  assert.equal(d.endings, 1);
  assert.equal(d.hasTimeline, true);
  assert.equal(d.meta.title, '摘要');
});

test('describeSave 对空历史不崩', () => {
  const d = describeSave({ state: {} });
  assert.equal(d.turn, 0);
  assert.equal(d.day, null);
});

/* ---------------------------------------------------------------- *
 * 确定性
 * ---------------------------------------------------------------- */

test('导出 → 导入 → 再导出 文本一致', () => {
  const s = stateFixture({ clues: ['C01'] });
  const opts = { now: '2026-06-06T06:06:06.000Z' };
  const first = exportState(s, { t: 1 }, opts);

  // 第二次导出沿用同一 createdAt，模拟「同一存档再次保存」
  const parsed = deserialize(first);
  const second = serialize({ ...parsed, updatedAt: parsed.updatedAt, createdAt: parsed.createdAt });

  assert.equal(second, first);
});
