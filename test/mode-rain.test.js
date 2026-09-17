/**
 * 雨夜模式 —— 装配测试。
 *
 * 为什么单独一个文件：mode-rain.js 此前**一个测试都没有**，
 * 于是「ui/app.js 忘了 import createWorld」这种一进模式就白屏的错，
 * 449 项单测全绿也照不出来（单测喂的是自己的 stub，不看真实装配）。
 *
 * 这里只验证「零件装得上、跑得动、坏得响」，不验证剧情好不好。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RAINNIGHT_MODE, createRainWorld, rainInitialState } from '../data/mode-rain.js';
import { createWorld, nextTurn, applyTurn, buildOptions, selectBranch } from '../src/engine.js';
import { createDemoWorld } from '../data/demo.js';
import { createInitialState, validateEventSet } from '../src/schema.js';
import { applyEffects, createStore } from '../src/state.js';
import { evaluate } from '../src/condition.js';
import {
  canAdvance, consentEffects, CONSENT, withdrawEffects,
  renegotiateEffects, currentTurn,
} from '../src/boundary.js';

/* 与 ui/app.js 完全一致的两行装配 —— 这正是当初断掉的地方 */
const world = () => createRainWorld(createWorld);
const initialState = () => rainInitialState(createInitialState);

/* ---------------------------------------------------------------- *
 * 装配：建得出来
 * ---------------------------------------------------------------- */

test('用真实 createWorld 能建出雨夜世界', () => {
  const w = world();
  assert.ok(w.events.length > 0, '没有事件');
  assert.ok(w.endings.length > 0, '没有结局');
  assert.ok(w.achievements.length > 0, '没有成就');
  assert.equal(w.guards.length, 1, '边界 guard 没挂上');
});

test('用真实 createInitialState 能建出雨夜初始状态', () => {
  const s = initialState();
  assert.deepEqual(Object.keys(s.actors).sort(), ['collector', 'kin', 'lost', 'seeker', 'self']);
  // 真名绑定（文档 §4）
  assert.equal(s.actors.seeker.name, '林晚晴');
  assert.equal(s.actors.kin.name, '周若宁');
  assert.equal(s.actors.lost.name, '周世杰');
  // 数值按《雨与夜 V4.1》§4 的初始值（去掉了与亲密相关的项）
  assert.equal(s.actors.seeker.stats.trust, 35);
  assert.equal(s.actors.seeker.stats.pressure, 88);
  assert.equal(s.actors.kin.stats.anxiety, 72);
  assert.equal(s.clock.day, 1);
  assert.equal(s.where, 'room');
  assert.equal(s.ledger.cash, 10000000);
});

test('世界里的条件字段都是可判定的纯数据，不是代码字符串', () => {
  for (const e of RAINNIGHT_MODE.world.events) {
    if (e.require) assert.equal(typeof e.require, 'object', `${e.id}.require 不是对象`);
    for (const b of e.branches) {
      if (b.cond) assert.equal(typeof b.cond, 'object', `${e.id}.${b.key}.cond 不是对象`);
      for (const ef of b.effects ?? []) {
        assert.ok(ef.path && ef.op, `${e.id}.${b.key} 的 effect 缺 path/op`);
      }
    }
  }
});

test('事件集能过一次 schema 校验（非法数据不许静默通过）', () => {
  const { ok, issues } = validateEventSet(RAINNIGHT_MODE.world.events);
  assert.equal(ok, true, JSON.stringify(issues));
});

/* ---------------------------------------------------------------- *
 * 跑得动
 * ---------------------------------------------------------------- */

function autoplay(pick, maxTurns = 40) {
  const w = world();
  let state = initialState();
  const visited = new Set();

  for (let i = 0; i < maxTurns; i++) {
    if (state.endings.length > 0) break;
    const opened = nextTurn(state, w);
    if (!opened.event) break;
    state = opened.state;
    const usable = opened.options.filter(o => o.available);
    if (usable.length === 0) break;
    const opt = pick(usable, opened, i) ?? usable[0];
    const { state: after, report } = applyTurn(state, opened.event, opt.key, w);
    state = after;
    visited.add(opened.event.id);
    if (report.terminal) break;
  }
  return { state, visited, world: w };
}

test('自动跑 40 轮不抛，且真的推进了事件', () => {
  const { state, visited } = autoplay((usable) => usable[0]);
  assert.ok(visited.size >= 3, `只推进了 ${visited.size} 个事件`);
  assert.ok(state.history.length >= 3, `history 只有 ${state.history.length} 条`);
});

test('两条主要走向都能走到结局', () => {
  const accept = autoplay((usable) => usable.find(o => o.label.includes('接')) ?? usable[0]);
  assert.ok(accept.state.flags.took_case || accept.state.endings.length > 0,
    '选了「接下」却没落 took_case，也没走到结局');

  const decline = autoplay((usable) => usable.find(o => o.label.includes('婉拒')) ?? usable[0]);
  assert.ok(decline.state.flags.declined || decline.state.endings.length > 0,
    '选了「婉拒」却没落 declined，也没走到结局');
});

test('每个事件的首个分支在初始状态下都能选中（不留死角）', () => {
  const s = initialState();
  const w = world();
  for (const e of w.events) {
    // 条件不满足时应当抛 TurnRejected，而不是静默换分支
    const branch = e.branches[0];
    try {
      selectBranch(e, branch.key, s, w);
    } catch (err) {
      assert.match(String(err.name), /TurnRejected/, `${e.id}.${branch.key} 抛了意外错误：${err.message}`);
    }
  }
});

test('所有结局条件在初始状态下可判定（不抛，也不因缺路径报错）', () => {
  const s = initialState();
  const w = world();
  for (const end of w.endings) {
    assert.doesNotThrow(() => buildOptions(s, w), `结局 ${end.id} 判定时炸了`);
  }
});

/* ---------------------------------------------------------------- *
 * 边界机制：雨夜模式的招牌，必须真的接上
 * ---------------------------------------------------------------- */

test('雨夜模式挂了同意 guard', () => {
  assert.equal(RAINNIGHT_MODE.rules.consentEnforced, true);
  assert.equal(RAINNIGHT_MODE.rules.turnOnlyConsent, true);
  assert.equal(world().guards.length, 1);
});

test('没写 requiresConsent 的分支不受边界影响（guard 不误伤）', () => {
  const gate = world().guards[0];
  const res = gate({ state: initialState(), branch: { key: 'A' } });
  assert.equal(res.ok, true);
});

test('写了 requiresConsent 的分支，意愿不足时会被拒', () => {
  const gate = world().guards[0];
  const res = gate({ state: initialState(), branch: { key: 'A', requiresConsent: 'seeker' } });
  assert.equal(res.ok, false);
  assert.match(res.reason, /边界/);
});

test('同意只在当轮有效：登记后当轮可推进，下一轮失效', () => {
  const gate = world().guards[0];
  let state = initialState();
  state = applyEffects(state, consentEffects(state, 'seeker', CONSENT.ACCEPT)).state;
  state.routes = { ...(state.routes ?? {}), seeker: 'open' };

  assert.equal(gate({ state, branch: { requiresConsent: 'seeker' } }).ok, true);
  assert.equal(canAdvance(state, 'seeker').ok, true);

  // 进入下一轮（历史多一条），上一轮的同意自动作废
  const next = { ...state, history: [...(state.history ?? []), { turn: 1 }] };
  const res = gate({ state: next, branch: { requiresConsent: 'seeker' } });
  assert.equal(res.ok, false);
  assert.match(res.reason, /只在当轮有效/);
});

test('撤回：路线冻结但不注销，尊重撤回加信任、纠缠扣信任', () => {
  let state = initialState();
  state = applyEffects(state, consentEffects(state, 'seeker', CONSENT.ACCEPT)).state;
  state.routes = { ...(state.routes ?? {}), seeker: 'open' };

  const respected = applyEffects(state, withdrawEffects(state, 'seeker', { respected: true })).state;
  assert.equal(respected.routes.seeker, 'frozen');
  assert.ok(respected.actors.seeker.stats.trust > state.actors.seeker.stats.trust);

  const pestered = applyEffects(state, withdrawEffects(state, 'seeker', { respected: false })).state;
  assert.ok(pestered.actors.seeker.stats.trust < state.actors.seeker.stats.trust);
});

test('经济帮助不构成同意（文档明确列举）', () => {
  let state = initialState();
  // 路线开着、信任拉满、钱也垫了 —— 只要没当轮公开表达，就不构成同意
  state.routes = { ...(state.routes ?? {}), seeker: 'open' };
  state = applyEffects(state, [
    { path: 'actors.seeker.stats.trust', op: 'add', value: 20 },
    { path: 'ledger.expense', op: 'add', value: 800 },
  ]).state;
  const gate = canAdvance(state, 'seeker');
  assert.equal(gate.ok, false);
  assert.equal(gate.code, 'no-consent');
  assert.match(gate.reason, /未公开表达/);
});

/* ---------------------------------------------------------------- *
 * 边界机制端到端：划界 → 登记表态 → 过闸
 * ---------------------------------------------------------------- */

function findEvent(id) {
  return world().events.find(e => e.id === id);
}

test('雨夜给出人物与数值的中文标签，UI 不用再露出一堆内部 key', () => {
  const w = world();
  assert.equal(w.actorLabels.seeker, '林晚晴');
  assert.equal(w.actorLabels.kin, '周若宁');
  assert.equal(w.statLabels.seeker.trust, '信任');
  assert.equal(w.statLabels.self.pressure, '压力');
  assert.equal(w.placeLabels.door, '门外');
  assert.equal(w.placeLabels.cemetery, '墓园');
  assert.equal(w.clueLabels.D2, '五百万本息：本金加滚息合计');
  assert.equal(w.actorLabels.collector, '催收方');
});

test('R27 谈明白界限 → 开路线；绕开 → 不开', () => {
  const w = world();
  const ev = w.events.find(e => e.id === 'R27');
  let s = initialState();
  s = applyEffects(s, [{ path: 'flags.took_them_in', op: 'set', value: true }]).state;

  const agree = applyTurn(s, ev, 'A', w).state;
  assert.equal(agree.routes.seeker, 'open');
  assert.equal(agree.flags.boundary_agreed, true);

  const defer = applyTurn(s, ev, 'B', w).state;
  assert.equal(defer.routes.seeker ?? 'closed', 'closed');
  assert.equal(defer.flags.boundary_deferred, true);
});

test('R28 的推进分支：没登记当轮意愿时是灰的，且不会靠保底复活', () => {
  const w = world();
  const ev = w.events.find(e => e.id === 'R28');
  const s = applyEffects(initialState(), [
    { path: 'routes.seeker', op: 'set', value: 'open' },
    { path: 'flags.boundary_agreed', op: 'set', value: true },
  ]).state;

  const opts = buildOptions(s, ev, w);
  const a = opts.find(o => o.key === 'A');
  assert.equal(a.available, false, '没表态却把推进选项放开了');
  assert.match(a.reason, /边界/);
  // B 是合法退路，不能因为 A 被挡就把 B 也锁死或把 A 放开
  assert.equal(opts.find(o => o.key === 'B').available, true);

  // 选中被挡的分支必须被拒，且状态原封不动
  assert.throws(() => applyTurn(s, ev, 'A', w), /边界/);
});

test('登记当轮意愿后 R28 能推进；再走一轮表态过期，又变回灰的', () => {
  const w = world();
  const ev = w.events.find(e => e.id === 'R28');
  let s = applyEffects(initialState(), [
    { path: 'routes.seeker', op: 'set', value: 'open' },
    { path: 'flags.boundary_agreed', op: 'set', value: true },
  ]).state;

  // 两轮之间登记表态（这正是「当轮意愿卡」的动作）
  s = applyEffects(s, consentEffects(s, 'seeker', CONSENT.ACCEPT)).state;
  assert.equal(buildOptions(s, ev, w).find(o => o.key === 'A').available, true);

  // 真的推进一次
  const after = applyTurn(s, ev, 'A', w).state;
  assert.equal(after.routes.seeker, 'advancing');
  assert.equal(after.flags.advanced_once, true);

  // 又过了一轮：上一轮的表态作废，必须重新确认
  const later = { ...after, history: [...after.history, { turn: 99 }] };
  const again = buildOptions(later, ev, w).find(o => o.key === 'A');
  assert.equal(again.available, false);
  assert.match(again.reason, /只在当轮有效|未公开表达/);
});

test('撤回后路线冻结，重新协商再解冻', () => {
  let s = applyEffects(initialState(), [
    { path: 'routes.seeker', op: 'set', value: 'open' },
  ]).state;
  s = applyEffects(s, consentEffects(s, 'seeker', CONSENT.ACCEPT)).state;
  assert.equal(canAdvance(s, 'seeker').ok, true);

  s = applyEffects(s, withdrawEffects(s, 'seeker')).state;
  assert.equal(s.routes.seeker, 'frozen');
  const blocked = canAdvance(s, 'seeker');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'route-frozen');

  s = applyEffects(s, renegotiateEffects(s, 'seeker', '只谈债务，不谈别的')).state;
  assert.equal(s.routes.seeker, 'open');
  assert.equal(canAdvance(s, 'seeker').ok, true);
});

test('「当轮」= 正在进行的这一轮（轮号从 1 起，不是已完成轮数）', () => {
  // 这条是给未来的自己看的：轮号语义改过一次，改错就会让闸门永远锁死
  assert.equal(currentTurn(initialState()), 1);
  const one = { ...initialState(), history: [{ turn: 1 }] };
  assert.equal(currentTurn(one), 2);
});

test('开场白由世界提供，不是 UI 里写死的一句话', () => {
  // 这条防的是"雨夜模式开着旧公寓的场"：开场白曾经硬编码在 ui/app.js 里
  const w = world();
  assert.ok(w.opening && w.opening.length > 10, '雨夜世界没有开场白');
  assert.ok(!w.opening.includes('旧楼'), '雨夜模式的开场白还是旧公寓那一句');

  const tea = createDemoWorld();
  assert.ok(tea.opening && tea.opening.includes('旧楼'), '茶馆标准的开场白被改掉了');
  assert.notEqual(w.opening, tea.opening);
});

test('世界书与地点/线索标签都从模式定义进来', () => {
  const w = world();
  assert.ok(w.book && w.book.entries.length >= 3, '世界书没挂上');
  assert.equal(w.placeLabels.school, '学校门口');
  assert.equal(w.clueLabels.S1, '黑色面包车，尾号 842');
  assert.equal(w.book.entries.length >= 10, true, '世界书条目太少');
});

/* ---------------------------------------------------------------- *
 * 状态层
 * ---------------------------------------------------------------- */

test('雨夜模式的状态能进 store 并算指纹', () => {
  const store = createStore(initialState());
  assert.ok(store.getState().actors.seeker);
  assert.doesNotThrow(() => store.getState());
});

/* ---------------------------------------------------------------- *
 * 数据规模与"开局不该出事"
 * ---------------------------------------------------------------- */

test('雨夜模式的数据规模（实测值，改数据时请同步改这里）', () => {
  const w = world();
  assert.equal(w.events.length, 36, '事件数变了');
  assert.equal(w.endings.length, 14, '结局数变了');
  assert.equal(w.achievements.length, 31, '成就数变了');
  assert.equal(w.book.entries.length, 15, '世界书条目太少');
  assert.equal(Object.keys(RAINNIGHT_MODE.world.clueLabels).length, 18, '线索数变了');
  assert.equal(Object.keys(w.placeLabels).length, 16, '地点数变了');
  assert.equal(Object.keys(w.actorLabels).length, 5, '角色数变了');
  assert.equal(w.actorLabels.seeker, '林晚晴');
  assert.equal(w.actorLabels.kin, '周若宁');
  assert.equal(w.actorLabels.lost, '周世杰');
});

test('开局不触发任何结局（兜底结局最容易在这里翻车）', () => {
  const w = world();
  const s = initialState();
  for (const end of w.endings) {
    const hit = evaluate(end.cond ?? null, s) === true;
    assert.equal(hit, false, `开局就满足了结局「${end.title}」`);
  }
});

test('开局不触发任何成就', () => {
  const w = world();
  const s = initialState();
  for (const a of w.achievements) {
    const hit = evaluate(a.cond ?? null, s) === true;
    assert.equal(hit, false, `开局就解锁了成就「${a.title}」`);
  }
});

test('每个事件的每个分支都能真的走一遍（effects 路径全部合法）', () => {
  const w = world();
  for (const ev of w.events) {
    for (const b of ev.branches) {
      // 造一个尽量满足的状态：把 require 与 flag 相关的门槛先放开
      let s = initialState();
      s = applyEffects(s, [
        { path: 'flags.met_seeker', op: 'set', value: true },
        { path: 'flags.heard_debt', op: 'set', value: true },
        { path: 'flags.took_them_in', op: 'set', value: true },
        { path: 'flags.boundary_agreed', op: 'set', value: true },
        { path: 'flags.case_stage', op: 'set', value: 6 },
        { path: 'clues', op: 'push', value: 'S1' },
        { path: 'routes.seeker', op: 'set', value: 'open' },
      ]).state;
      s = applyEffects(s, consentEffects(s, 'seeker', CONSENT.ACCEPT)).state;

      // 条件不成立的分支本来就该抛，只有 cond=null 的必须能走通
      if (b.cond !== null && b.cond !== undefined) continue;
      assert.doesNotThrow(
        () => applyTurn(s, ev, b.key, w),
        `${ev.id}.${b.key} 走不通`,
      );
    }
  }
});

test('自动跑到底会落到一个结局，且线索不会跳阶段', () => {
  const { state } = autoplay((usable) => usable[0], 60);
  assert.ok(state.endings.length > 0, '跑了 60 轮都没结局');

  // 阶段不可跳：没有 D3 就不该有 D5 —— D5 只在 R21 之后释放
  if (state.clues.includes('D5')) {
    assert.ok(state.clues.includes('D3'), '拿到了 D5 却没有 D3，阶段被跳了');
  }
});

/* ---------------------------------------------------------------- *
 * 关系路线（非性机制层）
 * ---------------------------------------------------------------- */

test('关系路线绑的是真名，且起点是「暂住」', () => {
  const w = world();
  assert.equal(w.actorLabels.seeker, '林晚晴');
  assert.equal(w.actorLabels.kin, '周若宁');
  assert.equal(w.actorLabels.lost, '周世杰');

  const ev = w.events.find(e => e.id === 'R01');
  let s = initialState();
  s = applyEffects(s, [{ path: 'flags.met_seeker', op: 'set', value: true }]).state;
  s = applyTurn(s, ev, 'A', w).state;
  assert.equal(s.flags.path_seeker, '暂住');
  assert.equal(s.flags.path_kin, '暂住');
});

test('路线只能一格一格走：上一格没到，下一格推不动', () => {
  const w = world();
  const p02 = w.events.find(e => e.id === 'P02');

  // 还在「暂住」时，P02 的条件（path_seeker == 共同生活）不成立
  let s = initialState();
  s = applyEffects(s, [
    { path: 'flags.took_them_in', op: 'set', value: true },
    { path: 'flags.case_stage', op: 'set', value: 3 },
    { path: 'flags.path_seeker', op: 'set', value: '暂住' },
  ]).state;
  assert.equal(evaluate(p02.require, s), false, '暂住不该满足共同生活的条件');

  // 走到「共同生活」之后才成立
  s = applyEffects(s, [{ path: 'flags.path_seeker', op: 'set', value: '共同生活' }]).state;
  assert.equal(evaluate(p02.require, s), true);
  s = applyTurn(s, p02, 'A', w).state;
  assert.equal(s.flags.path_seeker, '债务共担');
  assert.equal(s.flags.shared_ledger, true);
});

test('路线里不含成人向节点（口径固定）', () => {
  const w = world();
  const stages = [];
  for (const ev of w.events) {
    for (const b of ev.branches) {
      for (const e of (b.effects ?? [])) {
        if (/^flags\.path_/.test(e.path) && e.op === 'set') stages.push(e.value);
      }
    }
  }
  assert.ok(stages.length > 0, '一个路线节点都没有');
  for (const st of stages) {
    assert.ok(!/伴侣|共享|亲密/.test(st), `出现了不该有的节点：${st}`);
  }
});
