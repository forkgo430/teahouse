import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState, SchemaError } from '../src/schema.js';
import { hashState } from '../src/state.js';
import {
  DEFAULT_SLOT_LABELS,
  TurnRejected,
  createWorld,
  buildIndex,
  matchesContext,
  isConsumed,
  pickEvent,
  inspectContext,
  advanceClock,
  availableBranches,
  selectBranch,
  buildOptions,
  checkAchievements,
  checkEndings,
  applyTurn,
  nextTurn,
  runTurn,
  buildView,
} from '../src/engine.js';

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
      { id: 'neighbor', name: '邻居', stats: [
        { key: 'trust', min: 0, max: 100, init: 10 },
      ] },
    ],
    clock: { day: 1, slot: 'night' },
    where: 'room',
    ledger: { cash: 5000, income: 0, expense: 0 },
  });
  return { ...s, ...overrides };
}

function eventFixture(overrides = {}) {
  return {
    id: 'E01',
    title: '敲门声',
    when: { day: 1, slot: 'night' },
    where: 'room',
    priority: 10,
    actors: ['keeper'],
    firstMet: ['keeper'],
    require: null,
    branches: [
      {
        key: 'A',
        label: '开门',
        cond: null,
        text: '门开了。',
        effects: [
          { path: 'actors.keeper.stats.trust', op: 'add', value: 15 },
          { path: 'ledger.cash', op: 'sub', value: 200 },
        ],
        unlock: { clue: 'C01', flag: 'door_opened', route: { actor: 'keeper', state: 'open' } },
      },
      {
        key: 'B',
        label: '不开',
        cond: { path: 'actors.keeper.stats.guard', op: '>', value: 90 },
        text: '你没有开门。',
        effects: [{ path: 'actors.keeper.stats.guard', op: 'add', value: 10 }],
      },
    ],
    fallback: 'A',
    ...overrides,
  };
}

function worldFixture(extra = {}) {
  return createWorld({
    events: [eventFixture()],
    achievements: [
      { id: 'A01', title: '初次照面', cond: { path: 'actors.keeper.met', op: '==', value: true } },
      { id: 'A02', title: '信任建立', cond: { path: 'actors.keeper.stats.trust', op: '>=', value: 80 } },
    ],
    endings: [
      { id: 'END01', title: '留下', priority: 5, cond: { path: 'flags.door_opened', op: '==', value: true } },
      { id: 'END02', title: '离开', priority: 1, cond: { path: 'clock.day', op: '>=', value: 1 } },
    ],
    ...extra,
  });
}

/* ---------------------------------------------------------------- *
 * 索引与命中
 * ---------------------------------------------------------------- */

test('buildIndex 按 day 建桶，通配事件进 * 桶', () => {
  const fixed = eventFixture({ id: 'E01', when: { day: 1, slot: 'night' } });
  const anyDay = eventFixture({ id: 'E02', when: { slot: 'night' } });
  const { byDay } = buildIndex([fixed, anyDay]);
  assert.equal(byDay.get(1).length, 1);
  assert.equal(byDay.get(1)[0].id, 'E01');
  assert.equal(byDay.get('*').length, 1);
  assert.equal(byDay.get('*')[0].id, 'E02');
});

test('buildIndex 支持 when.day 为数组', () => {
  const ev = eventFixture({ id: 'E03', when: { day: [1, 3, 5], slot: 'night' } });
  const { byDay } = buildIndex([ev]);
  assert.deepEqual([...byDay.keys()].sort((a, b) => a - b), [1, 3, 5], '键是数字');
});

test('matchesContext 逐项校验 day / slot / where', () => {
  const s = stateFixture();
  assert.equal(matchesContext(eventFixture(), s), true);

  assert.equal(matchesContext(eventFixture({ when: { day: 2, slot: 'night' } }), s), false);
  assert.equal(matchesContext(eventFixture({ when: { day: 1, slot: 'morning' } }), s), false);
  assert.equal(matchesContext(eventFixture({ where: 'roof' }), s), false);
  assert.equal(matchesContext(eventFixture({ where: ['roof', 'room'] }), s), true);
  assert.equal(matchesContext(eventFixture({ where: undefined }), s), true, '不给 where 表示不限地点');
});

test('matchesContext 会看 require 条件', () => {
  const s = stateFixture();
  const blocked = eventFixture({ require: { path: 'actors.keeper.stats.trust', op: '>=', value: 90 } });
  assert.equal(matchesContext(blocked, s), false);
  const open = eventFixture({ require: { path: 'actors.keeper.stats.trust', op: '>=', value: 10 } });
  assert.equal(matchesContext(open, s), true);
});

test('pickEvent 命中 priority 最高者', () => {
  const s = stateFixture();
  const world = createWorld({ events: [
    eventFixture({ id: 'E01', priority: 1 }),
    eventFixture({ id: 'E02', priority: 9 }),
    eventFixture({ id: 'E03', priority: 5 }),
  ] });
  assert.equal(pickEvent(s, world).id, 'E02');
});

test('priority 相同时按 id 升序（稳定）', () => {
  const s = stateFixture();
  const world = createWorld({ events: [
    eventFixture({ id: 'E09', priority: 3 }),
    eventFixture({ id: 'E02', priority: 3 }),
  ] });
  assert.equal(pickEvent(s, world).id, 'E02');
});

test('pickEvent 在无命中时返回 null', () => {
  const s = stateFixture({ where: 'roof' });
  assert.equal(pickEvent(s, worldFixture()), null);
});

test('isConsumed：非 repeat 事件只触发一次', () => {
  const s = stateFixture();
  const ev = eventFixture();
  assert.equal(isConsumed(ev, s), false);

  const s2 = stateFixture({ history: [{ turn: 1, eventId: 'E01', branchKey: 'A' }] });
  assert.equal(isConsumed(ev, s2), true);

  const rep = eventFixture({ repeat: true });
  assert.equal(isConsumed(rep, s2), false);
});

test('pickEvent 跳过已触发过的事件', () => {
  const s = stateFixture({ history: [{ turn: 1, eventId: 'E01', branchKey: 'A' }] });
  assert.equal(pickEvent(s, worldFixture()), null);
});

test('inspectContext 列出候选与阻塞原因', () => {
  const s = stateFixture();
  const rows = inspectContext(s, worldFixture());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'E01');
  assert.equal(rows[0].matches, true);
  assert.equal(rows[0].blockedBy, null);
});

/* ---------------------------------------------------------------- *
 * 时间推进
 * ---------------------------------------------------------------- */

test('advanceClock 在时段内递进', () => {
  const s = stateFixture({ clock: { day: 1, slot: 'morning' } });
  assert.deepEqual(advanceClock(s).clock, { day: 1, slot: 'afternoon' });
});

test('advanceClock 走完时段则进位到次日黎明', () => {
  const s = stateFixture({ clock: { day: 1, slot: 'night' } });
  assert.deepEqual(advanceClock(s).clock, { day: 2, slot: 'dawn' });
});

test('advanceClock 不修改原状态', () => {
  const s = stateFixture({ clock: { day: 1, slot: 'night' } });
  advanceClock(s);
  assert.deepEqual(s.clock, { day: 1, slot: 'night' });
});

test('nextTurn 无事件时推进时间直到命中', () => {
  const s = stateFixture({ where: 'entrance', clock: { day: 1, slot: 'night' } });
  const world = createWorld({ events: [eventFixture({ id: 'E01', when: { day: 1, slot: 'night' }, where: 'room' })] });
  const opened = nextTurn(s, world);
  assert.equal(opened.event, null, '1 天内找不到就推进到次日');

  const world2 = createWorld({ events: [eventFixture({ id: 'E02', when: { day: 2, slot: 'dawn' }, where: 'entrance' })] });
  const opened2 = nextTurn(s, world2);
  assert.equal(opened2.event.id, 'E02');
  assert.equal(opened2.state.clock.day, 2);
  assert.equal(opened2.state.clock.slot, 'dawn');
  assert.ok(opened2.skips.length > 0, '应记录跳过的时段');
});

/* ---------------------------------------------------------------- *
 * 分支选择与选项
 * ---------------------------------------------------------------- */

test('availableBranches 只返回条件成立的分支', () => {
  const s = stateFixture();
  const ev = eventFixture();
  const avail = availableBranches(s, ev);
  assert.deepEqual(avail.map(b => b.key), ['A'], 'B 需要 guard > 90');
});

test('selectBranch 精确匹配 key', () => {
  const s = stateFixture({ actors: { ...stateFixture().actors, keeper: { ...stateFixture().actors.keeper, stats: { trust: 20, guard: 95 } } } });
  const ev = eventFixture();
  assert.equal(selectBranch(s, ev, 'B').key, 'B');
  assert.equal(selectBranch(s, ev, { branchKey: 'B' }).key, 'B');
});

test('selectBranch 输入不存在的 key 直接抛错（不静默回落）', () => {
  const s = stateFixture();
  assert.throws(() => selectBranch(s, eventFixture(), 'ZZZ'), (e) => {
    assert.ok(e instanceof TurnRejected);
    assert.match(e.message, /不存在分支/);
    assert.equal(e.detail.reason, 'unknown-branch');
    return true;
  });
});

test('selectBranch 拒绝条件不成立的分支（不能绕过前置条件）', () => {
  const s = stateFixture();
  assert.throws(() => selectBranch(s, eventFixture(), 'B'), (e) => {
    assert.ok(e instanceof TurnRejected);
    assert.match(e.message, /前置条件不成立/);
    assert.equal(e.detail.reason, 'condition-unmet');
    return true;
  });
});

test('selectBranch 不给输入时取无条件分支', () => {
  const s = stateFixture();
  assert.equal(selectBranch(s, eventFixture(), undefined).key, 'A');
  assert.equal(selectBranch(s, eventFixture(), { branchKey: null }).key, 'A');
});

test('selectBranch 无输入时 fallback 优先', () => {
  const s = stateFixture();
  const ev = eventFixture({
    fallback: 'B',
    branches: [
      { key: 'A', cond: null, text: '' },
      { key: 'B', cond: null, text: '' },
    ],
  });
  assert.equal(selectBranch(s, ev, undefined).key, 'B');
});

test('fallback 条件不成立时退到其他可用分支', () => {
  const s = stateFixture();
  const ev = eventFixture({
    fallback: 'B',
    branches: [
      { key: 'A', cond: null, text: '' },
      { key: 'B', cond: { path: 'nope', op: '==', value: 1 }, text: '' },
    ],
  });
  assert.equal(selectBranch(s, ev, undefined).key, 'A');
});

test('selectBranch 完全无路可走时抛 TurnRejected', () => {
  const s = stateFixture();
  const ev = eventFixture({
    fallback: undefined,
    branches: [{ key: 'A', cond: { path: 'nope', op: '==', value: 1 }, text: '' }],
  });
  assert.throws(() => selectBranch(s, ev, undefined), (e) => {
    assert.ok(e instanceof TurnRejected);
    assert.match(e.message, /没有可用的分支/);
    assert.equal(e.detail.reason, 'no-branch');
    return true;
  });
});

test('buildOptions 标出可用与不可用及原因', () => {
  const s = stateFixture();
  const opts = buildOptions(s, eventFixture());
  assert.equal(opts.length, 2);
  assert.equal(opts[0].key, 'A');
  assert.equal(opts[0].available, true);
  assert.equal(opts[0].kind, 'default');
  assert.equal(opts[0].reason, null);

  assert.equal(opts[1].key, 'B');
  assert.equal(opts[1].available, false);
  assert.equal(opts[1].reason, '还差一些', '给玩家的理由不能暴露字段路径');
  assert.ok(!opts[1].reason.includes('.'), '理由里不应出现路径');
  assert.match(opts[1].reasonDetail, /guard/, '完整轨迹留在 reasonDetail');
});

test('buildOptions 在一个分支都不可用时强制打开保底项', () => {
  const s = stateFixture();
  const ev = eventFixture({
    fallback: 'B',
    branches: [
      { key: 'A', cond: { path: 'nope', op: '==', value: 1 }, text: '' },
      { key: 'B', cond: { path: 'nope2', op: '==', value: 1 }, text: '' },
    ],
  });
  const opts = buildOptions(s, ev);
  const usable = opts.filter(o => o.available);
  assert.equal(usable.length, 1);
  assert.equal(usable[0].key, 'B');
  assert.equal(usable[0].kind, 'fallback');
});

test('buildOptions 对 null 事件返回空数组', () => {
  assert.deepEqual(buildOptions(stateFixture(), null), []);
});

/* ---------------------------------------------------------------- *
 * 成就与结局
 * ---------------------------------------------------------------- */

test('checkAchievements 只返回尚未获得的', () => {
  const s = stateFixture({ actors: { ...stateFixture().actors, keeper: { ...stateFixture().actors.keeper, met: true } } });
  const world = worldFixture();
  const got = checkAchievements(s, world);
  assert.deepEqual(got.map(a => a.id), ['A01']);

  const s2 = { ...s, achievements: ['A01'] };
  assert.deepEqual(checkAchievements(s2, world).map(a => a.id), []);
});

test('checkEndings 按 priority 只取一个', () => {
  const s = stateFixture({ flags: { door_opened: true } });
  const world = worldFixture();
  const hit = checkEndings(s, world);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, 'END01', 'priority 5 > 1');
});

test('checkEndings 跳过已达成结局', () => {
  const s = stateFixture({ flags: { door_opened: true }, endings: ['END01'] });
  const hit = checkEndings(s, worldFixture());
  assert.equal(hit[0].id, 'END02');
});

/* ---------------------------------------------------------------- *
 * applyTurn
 * ---------------------------------------------------------------- */

test('applyTurn 应用数值、账本、unlock、挂角色与历史', () => {
  const s = stateFixture();
  const world = worldFixture();
  const { state: next, report } = applyTurn(s, world.events[0], 'A', world);

  assert.equal(next.actors.keeper.stats.trust, 35);
  assert.equal(next.ledger.cash, 4800);
  assert.equal(next.actors.keeper.met, true);
  assert.deepEqual(next.clues, ['C01']);
  assert.equal(next.flags.door_opened, true);
  assert.equal(next.routes.keeper, 'open');
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0].eventId, 'E01');
  assert.equal(next.history[0].branchKey, 'A');
  assert.equal(report.terminal, true, 'END01 条件满足');
  assert.equal(report.ending.id, 'END01');
});

test('applyTurn 不修改传入状态', () => {
  const s = stateFixture();
  const before = hashState(s);
  applyTurn(s, worldFixture().events[0], 'A', worldFixture());
  assert.equal(hashState(s), before);
});

test('applyTurn 的 report 带上首出场角色', () => {
  const s = stateFixture();
  const { report } = applyTurn(s, worldFixture().events[0], 'A', worldFixture());
  assert.deepEqual(report.firstMet, ['keeper']);
});

test('首出场只记一次', () => {
  const s = stateFixture();
  const world = worldFixture();
  const first = applyTurn(s, world.events[0], 'A', world).state;
  const ev2 = eventFixture({ id: 'E99', firstMet: ['keeper'] });
  const { report } = applyTurn(first, ev2, 'A', world);
  assert.deepEqual(report.firstMet, []);
});

test('applyTurn 命中成就时写入状态', () => {
  const s = stateFixture({ actors: { ...stateFixture().actors, keeper: { ...stateFixture().actors.keeper, met: true } } });
  const world = worldFixture();
  const { state: next, report } = applyTurn(s, world.events[0], 'A', world);
  assert.ok(next.achievements.includes('A01'));
  assert.ok(report.achievements.some(a => a.id === 'A01'));
});

test('guards 拒绝时不产生任何写入', () => {
  const s = stateFixture();
  const before = hashState(s);
  const world = worldFixture({
    guards: [() => ({ ok: false, reason: '禁止事项：该推进越界' })],
  });
  assert.throws(() => applyTurn(s, world.events[0], 'A', world), (e) => {
    assert.ok(e instanceof TurnRejected);
    assert.match(e.message, /越界/);
    return true;
  });
  assert.equal(hashState(s), before, '状态必须原封不动');
});

test('guards 通过时放行', () => {
  const s = stateFixture();
  const world = worldFixture({ guards: [() => ({ ok: true })] });
  const { state: next } = applyTurn(s, world.events[0], 'A', world);
  assert.equal(next.actors.keeper.stats.trust, 35);
});

test('guards 能拿到待执行的 effects', () => {
  let seen = null;
  const world = worldFixture({ guards: [(ctx) => { seen = ctx; return { ok: true }; }] });
  applyTurn(stateFixture(), world.events[0], 'A', world);
  assert.equal(seen.event.id, 'E01');
  assert.equal(seen.branch.key, 'A');
  assert.ok(Array.isArray(seen.effects));
  assert.equal(seen.effects.length, 2);
});

test('数值越界在 applyTurn 里被夹紧并记入 report', () => {
  const s = stateFixture();
  const ev = eventFixture({
    branches: [{
      key: 'A', cond: null, text: '',
      effects: [{ path: 'actors.keeper.stats.trust', op: 'add', value: 500 }],
    }],
  });
  const { state: next, report } = applyTurn(s, ev, 'A', worldFixture({ events: [ev] }));
  assert.equal(next.actors.keeper.stats.trust, 100);
  assert.ok(report.changes.some(c => c.clamped));
});

/* ---------------------------------------------------------------- *
 * 端到端与确定性
 * ---------------------------------------------------------------- */

test('runTurn 串起开启与应用', () => {
  const s = stateFixture();
  const world = worldFixture();
  const r = runTurn(s, 'A', world);
  assert.equal(r.report.kind, 'turn');
  assert.equal(r.report.eventId, 'E01');
  assert.equal(r.state.actors.keeper.stats.trust, 35);
});

test('runTurn 在无可推进事件时给出 idle 报告', () => {
  const s = stateFixture({ history: [{ turn: 1, eventId: 'E01', branchKey: 'A' }] });
  const r = runTurn(s, 'A', worldFixture());
  assert.equal(r.report.kind, 'idle');
  assert.equal(r.event, null);
});

test('同状态同输入两次运行结果指纹一致', () => {
  const world = worldFixture();
  const run = () => hashState(runTurn(stateFixture(), 'A', world).state);
  const first = run();
  for (let i = 0; i < 5; i++) assert.equal(run(), first);
});

test('条件成立时该分支可走，且通向不同状态', () => {
  const world = worldFixture();
  const base = stateFixture();
  const highGuard = {
    ...base,
    actors: {
      ...base.actors,
      keeper: { ...base.actors.keeper, stats: { trust: 20, guard: 95 } },
    },
  };

  const viaB = runTurn(highGuard, 'B', world).state;
  assert.equal(viaB.history[0].branchKey, 'B');
  assert.equal(viaB.actors.keeper.stats.guard, 100, '95+10 被夹紧到上限');

  const viaA = runTurn(highGuard, 'A', world).state;
  assert.equal(viaA.history[0].branchKey, 'A');
  assert.notEqual(hashState(viaA), hashState(viaB), '两条分支应通向不同状态');
});

/* ---------------------------------------------------------------- *
 * world 构造与视图
 * ---------------------------------------------------------------- */

test('createWorld 校验事件集，非法数据直接抛错', () => {
  assert.throws(() => createWorld({ events: [{ id: 'E01' }] }), (e) => {
    assert.ok(e instanceof SchemaError);
    assert.ok(e.issues.length >= 1);
    return true;
  });
});

test('createWorld 接受空事件集', () => {
  const w = createWorld({});
  assert.deepEqual(w.events, []);
  assert.equal(w.maxSkips, 12);
});

test('buildView 输出渲染所需字段', () => {
  const s = stateFixture({ clues: ['C01'] });
  const world = worldFixture();
  const view = buildView(s, world, { options: buildOptions(s, world.events[0]) });

  assert.equal(view.clock.day, 1);
  assert.equal(view.clock.slot, 'night');
  assert.equal(view.clock.label, DEFAULT_SLOT_LABELS.night);
  assert.equal(view.where, 'room');
  assert.equal(view.clues[0], 'C01');
  assert.equal(view.actors.length, 2);

  const keeper = view.actors.find(a => a.id === 'keeper');
  assert.equal(keeper.met, false);
  assert.equal(keeper.route, 'closed');
  const trust = keeper.stats.find(x => x.key === 'trust');
  assert.equal(trust.value, 20);
  assert.equal(trust.min, 0);
  assert.equal(trust.max, 100);
  assert.equal(view.options.length, 2);
});

test('buildView 可用自定义时段文案', () => {
  const world = createWorld({ events: [], slotLabels: { night: '夜里' } });
  const view = buildView(stateFixture(), world);
  assert.equal(view.clock.label, '夜里');
  assert.equal(view.clock.slot, 'night', '内部值不变');
});

test('buildView 的数组是副本，改不动状态', () => {
  const s = stateFixture({ clues: ['C01'] });
  const view = buildView(s, worldFixture());
  view.clues.push('X');
  assert.deepEqual(s.clues, ['C01']);
});
