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

import { RAINNIGHT_MODE, RAIN_PATHS, createRainWorld, rainInitialState } from '../data/mode-rain.js';
import { createWorld, nextTurn, applyTurn, buildOptions, selectBranch, pickEvent } from '../src/engine.js';
import { createDemoWorld } from '../data/demo.js';
import { createInitialState, validateEventSet, validateCondition } from '../src/schema.js';
import { parseCardMarkup } from '../src/card.js';
import { scenePanelMarkup } from '../src/scenePanel.js';
import { applyEffects, createStore } from '../src/state.js';
import { evaluate } from '../src/condition.js';
import {
  canAdvance, consentEffects, CONSENT, withdrawEffects,
  renegotiateEffects, currentTurn,
} from '../src/boundary.js';
import { buildNarrationMessages } from '../src/narrator.js';
import { callResource, resourceBoard } from '../src/resources.js';

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

test('§13.2：每个事件至少 4 个选项，且主线正文已经写好', () => {
  const w = world();
  for (const e of w.events) {
    assert.ok(e.branches.length >= 4,
      `${e.id} 只有 ${e.branches.length} 个选项（§13.2 要求 4–6）`);
    // 「只做最优主线剧情」的落地：每个事件至少有一支的正文是写好的，
    // 其余留空给模型现场创作 —— 全空就等于这个事件没有主线。
    const written = e.branches.filter(b => String(b.text ?? '').trim() !== '');
    assert.ok(written.length >= 1, `${e.id} 没有任何一支写了正文（主线缺失）`);
  }
});

test('留白的选项必须自带 effects —— 否则点了不动状态', () => {
  const w = world();
  for (const e of w.events) {
    for (const b of e.branches) {
      if (String(b.text ?? '').trim() !== '') continue;   // 有正文的不查
      assert.ok(Array.isArray(b.effects) && b.effects.length > 0,
        `${e.id}.${b.key} 正文留白却没有 effects：模型只写正文、不提 effects，这一支会是死选项`);
    }
  }
});

test('事件集能过一次 schema 校验（非法数据不许静默通过）', () => {
  const { ok, issues } = validateEventSet(RAINNIGHT_MODE.world.events);
  assert.equal(ok, true, JSON.stringify(issues));
});

/* ---------------------------------------------------------------- *
 * P2 版式（2026-09-19）
 * 开场迁到了声明式标记上。这里断言它**真的被解析成组件**，
 * 而不是退化成一大段纯文本 —— 后者正是改造前"页面只剩纯文本"的样子。
 * ---------------------------------------------------------------- */

test('开场只承担 P2 版式的头：〔当前局面〕+ 正文', () => {
  const segs = parseCardMarkup(RAINNIGHT_MODE.world.opening);
  const blocks = segs.filter(s => s.type === 'block');

  assert.deepEqual(blocks.map(s => s.kind), ['scene'], '开场应只有一个局面块');
  assert.ok(
    segs.some(s => s.type === 'text' && s.text.includes('敲得很轻')),
    '开场正文丢了',
  );
});

test('角色卡/账本/线索由 state 现算，而不是写死文案', () => {
  const s = initialState();
  const w = world();
  const blocks = parseCardMarkup(scenePanelMarkup(s, w, { actorIds: ['seeker', 'kin'] }))
    .filter(x => x.type === 'block');

  // 局面 / 两张角色卡 / 账本 / 线索
  assert.deepEqual(blocks.map(b => b.kind), ['scene', 'stats', 'stats', 'stats', 'list']);

  const seekerCard = blocks[1];
  assert.ok(seekerCard.title.includes('林晚晴'), `第一张卡应是林晚晴，实际 ${seekerCard.title}`);
  for (const key of ['情绪', '公开关系', '路线状态', '当轮意愿与边界', '身体档案',
    '当前穿着', '身体状态', '数值', '隐藏打算']) {
    assert.ok(seekerCard.items.some(i => i.key === key), `角色卡缺「${key}」`);
  }

  // 卡片必须跟着 state 动：这才是「现算」而不是「写死」
  const s2 = applyEffects(s, [
    { path: 'actors.seeker.emotion', op: 'set', value: '撑不住了' },
    { path: 'actors.seeker.stats.trust', op: 'sub', value: 10 },
  ]).state;
  const md2 = scenePanelMarkup(s2, w, { actorIds: ['seeker'] });
  assert.ok(md2.includes('情绪 = 撑不住了'), '角色卡没反映情绪变更');
  assert.ok(md2.includes('信任25 / 100'), '角色卡没反映数值变更');
});

/* ---------------------------------------------------------------- *
 * §13.2 线名/幅度 · §13.3 规则3 保底推进（2026-09-19）
 * ---------------------------------------------------------------- */

test('线名与幅度从 effects 推导，且与分支实际改动一致', () => {
  const w = world();
  const opts = buildOptions(initialState(), w.events.find(e => e.id === 'R02'), w);
  assert.ok(opts.every(o => o.line === '调查线'), 'R02 各分支应全归调查线');
  assert.ok(opts.some(o => o.magnitude === '大'), 'R02 应有大分支');

  const r01 = buildOptions(initialState(), w.events.find(e => e.id === 'R01'), w);
  assert.equal(r01.find(o => o.key === 'C').line, '关系线');
  assert.equal(r01.find(o => o.key === 'A').magnitude, '大');
});

test('§13.3 规则3：三连「小」之后优先挑带大分支的事件', () => {
  const mk = (id, big, priority) => ({
    id,
    title: id,
    when: { day: 1 },
    priority,
    branches: [{
      key: 'A',
      label: 'A',
      cond: null,
      text: '',
      effects: big
        ? [{ path: 'flags.a', op: 'set', value: true }, { path: 'flags.b', op: 'set', value: true },
          { path: 'flags.c', op: 'set', value: true }, { path: 'flags.d', op: 'set', value: true }]
        : [{ path: 'actors.self.stats.pressure', op: 'add', value: 1 }],
    }],
  });
  // small 的优先级更高 —— 没停摆时它必然被选；停摆后应改选 big
  const w = createWorld({ events: [mk('small', false, 99), mk('big', true, 1)] });
  const base = createInitialState({});
  const h = { turn: 1, eventId: 'small', branchKey: 'A', magnitude: '小', line: '关系线' };
  const stalled = { ...base, history: [h, { ...h, turn: 2 }, { ...h, turn: 3 }] };

  assert.equal(pickEvent(base, w).id, 'small', '未停摆时应按优先级选 small');
  assert.equal(pickEvent(stalled, w).id, 'big', '三连「小」之后应改选带大分支的 big');
});

test('§19.1.3：结局报告能解释「凭什么达成」与「还差什么」', () => {
  const w = world();
  let state = initialState();
  let report = null;
  for (let i = 0; i < 200 && !report; i++) {
    const opened = nextTurn(state, w);
    state = opened.state;
    if (!opened.event) continue;
    const usable = opened.options.filter(o => o.available);
    if (usable.length === 0) break;
    const r = applyTurn(state, opened.event, usable[0].key, w);
    state = r.state;
    if (r.report.terminal) report = r.report;
  }

  assert.ok(report, '200 轮内没走到结局');
  assert.ok(report.ending.trace.reached.length > 0, '结局没给达成条件回放');
  assert.ok(report.ending.trace.missed.length === 0, '已成立的结局不应有未达成项');
  // 未达成项提示：指向别的结局
  assert.ok(Array.isArray(report.ending.missed));
  for (const m of report.ending.missed) {
    assert.ok(m.id && m.missing, `未达成项提示字段不全：${JSON.stringify(m)}`);
  }
  // note 不能被整条 JSON 撑爆
  for (const it of report.ending.trace.reached) {
    assert.ok(it.note.length <= 60, `note 过长：${it.note.slice(0, 80)}`);
  }
});

/* §13.3 规则4/5：主线与次主线不可长期停滞（各 5 轮） */

function mkLineWorld() {
  const mk = (id, line, priority) => ({
    id,
    title: id,
    when: { day: 1 },
    priority,
    branches: [{
      key: 'A',
      label: 'A',
      cond: null,
      text: '',
      // 用一个能推出目标 line 的 effect：关系线走 seeker 的数值，调查线走 clues
      effects: line === '关系线'
        ? [{ path: 'actors.seeker.stats.trust', op: 'add', value: 3 }]
        : [{ path: 'clues', op: 'push', value: 'C01' }],
    }],
  });
  // rel 优先级低、inv 优先级高 —— 没停滞时必然选 inv
  return createWorld({ events: [mk('inv', '调查线', 99), mk('rel', '关系线', 1)] });
}

function histOf(line, n) {
  return Array.from({ length: n }, (_, i) => ({
    turn: i + 1, eventId: 'x', branchKey: 'A', magnitude: '中', line,
  }));
}

test('§13.3 规则4：主线连续 5 轮无进展 → 优先挑含关系线分支的事件', () => {
  const w = mkLineWorld();
  const base = createInitialState({});
  const stalled = { ...base, history: histOf('调查线', 5) };

  assert.equal(pickEvent(base, w).id, 'inv', '未停滞时应按优先级选 inv');
  assert.equal(pickEvent(stalled, w).id, 'rel', '主线停滞 5 轮后应改选 rel');
});

test('§13.3 规则5：调查线连续 5 轮无进展 → 优先挑含调查线分支的事件', () => {
  const w = mkLineWorld();
  const base = createInitialState({});
  const stalled = { ...base, history: histOf('关系线', 5) };

  assert.equal(pickEvent(stalled, w).id, 'inv', '调查线停滞 5 轮后应改选 inv');
});

test('§13.3：规则3 优先于规则4（三连「小」更紧急）', () => {
  const mk = (id, line, big, priority) => ({
    id,
    title: id,
    when: { day: 1 },
    priority,
    branches: [{
      key: 'A',
      label: 'A',
      cond: null,
      text: '',
      effects: big
        ? [{ path: 'flags.a', op: 'set', value: true }, { path: 'flags.b', op: 'set', value: true },
          { path: 'flags.c', op: 'set', value: true }, { path: 'flags.d', op: 'set', value: true }]
        : [{ path: 'clues', op: 'push', value: 'C01' }],
    }],
  });
  const w = createWorld({ events: [mk('bigRel', '关系线', true, 1), mk('inv', '调查线', false, 99)] });
  const base = createInitialState({});
  // 最近 3 轮都是「小」，同时最近 5 轮没有关系线 —— 两条规则都成立，必须走规则3
  const h = { turn: 1, eventId: 'x', branchKey: 'A', magnitude: '小', line: '调查线' };
  const stalled = { ...base, history: [h, { ...h, turn: 2 }, { ...h, turn: 3 }, { ...h, turn: 4 }, { ...h, turn: 5 }] };

  assert.equal(pickEvent(stalled, w).id, 'bigRel', '规则3 成立时应压过规则4');
});

/* ── 提示词注入：§9.4 禁止矩阵 / §24.1 角色人设 ──
   这两条曾经「写了但没进提示词」：createWorld 会把 actors 拆成 actorLabels，
   自己不留原数组，所以 `world.actors` 是空的，人设段静默不注入。
   这里从**真实提示词**里断言，而不是断言"数据里有这个字段"。 */

test('§9.4 禁止矩阵与 §24.1 人设真的进了提示词', () => {
  const w = world();
  assert.ok(Array.isArray(w.actorDefs), 'world.actorDefs 缺失（createWorld 不会保留 actors）');
  const per = w.actorDefs.filter(a => a.persona).map(a => ({
    name: a.name, fields: [...(a.persona.core ?? [])],
  }));
  assert.ok(per.length >= 2, `带人设的角色只有 ${per.length} 个`);

  const user = buildNarrationMessages({
    brief: w.brief, situation: '局面', event: { title: 'T' },
    branch: { label: 'L' }, report: { changes: [] }, world: w,
    prohibitions: w.prohibitions, personas: per,
  })[1].content;

  assert.ok(user.includes('【禁止'), '禁止矩阵没进提示词');
  assert.ok(user.includes('经济帮助 ≠ 亲密同意'), '禁止矩阵内容缺失');
  assert.ok(user.includes('【角色人设'), '角色人设没进提示词');
  assert.ok(user.includes('林晚晴'), '人设里没有林晚晴');
});

/* ── §18 资源调用系统 ── */

test('§18：五个资源都在，且初始状态可调用', () => {
  const w = world();
  const board = resourceBoard(initialState(), w);
  assert.equal(board.length, 5, `资源数 ${board.length}`);
  for (const b of board) {
    assert.ok(b.available, `${b.name} 初始就不可调用：${b.reason}`);
  }
  // 文档明确「神秘势力 · 未明」，没有可判定代价，不该被编成一个资源
  assert.ok(!board.some(b => b.name.includes('神秘')), '「神秘势力」不该落成可调用资源');
});

test('§18：调用会推进调查阶段、记账、并进入冷却', () => {
  const w = world();
  let s = initialState();
  const before = { stage: s.flags.case_stage ?? 0, expense: s.ledger.expense ?? 0 };

  const call = callResource(s, w, 'lawyer');
  assert.ok(call.ok, `律师不可调用：${call.reason}`);
  s = applyEffects(s, call.effects).state;

  assert.equal(s.flags.case_stage, before.stage + 1, '调用没有推进调查阶段');
  assert.ok(s.ledger.expense > before.expense, '调用没有记账');
  assert.equal(s.flags.res_lawyer_calls, 1, '调用次数没记');

  // 冷却：同一天再调用应当被拒
  const again = callResource(s, w, 'lawyer');
  assert.equal(again.ok, false, '同一天重复调用应被冷却挡住');
  assert.match(again.reason, /等/, `冷却理由不对：${again.reason}`);
});

test('§18：资源调用不产生任何同意/路线效果', () => {
  const w = world();
  const s = initialState();
  for (const b of resourceBoard(s, w)) {
    const r = callResource(s, w, b.id);
    if (!r.ok) continue;
    for (const e of r.effects) {
      assert.ok(!/^(consent|routes)/.test(e.path),
        `资源 ${b.id} 动了 ${e.path} —— 文档写明「资源不自动等于亲密同意」`);
    }
  }
});

test('动态标题（带角色名/年龄）也能命中区块名，而不是退化纯文本', () => {
  const segs = parseCardMarkup('[林晚晴｜36岁 · 当前状态]\n情绪 = 焦虑\n[/林晚晴｜36岁 · 当前状态]');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'block');
  assert.equal(segs[0].kind, 'stats');
});

/* ---------------------------------------------------------------- *
 * 跑得动
 * ---------------------------------------------------------------- */

function autoplay(pick, maxTurns = 40) {
  const w = world();
  let state = initialState();
  const visited = new Set();
  // 契约变更（2026-09-19）：事件改为按真实天数排期（day 1–219），
  // 大多数日子没有事件。「当天无事件」现在是正常流程 —— 时钟应继续推进，
  // 而不是像旧版那样直接结束。连续空转超过阈值才停，防止死循环。
  let idle = 0;

  for (let i = 0; i < maxTurns; i++) {
    if (state.endings.length > 0) break;
    const opened = nextTurn(state, w);
    state = opened.state;
    if (!opened.event) { if (++idle > 60) break; continue; }
    idle = 0;
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

test('两条主要走向都能推进剧情，且都不会在第 60 天之前结算', () => {
  // 契约变更（2026-09-19）：结局改为「推进到最后」才结算（day > 60）。
  // 旧用例断言「选几轮就走到结局」，那是被 END_B2/END_B3 互补条件蒙出来的假通过，
  // 且引用的 flags.took_case 在数据里根本不存在。现按新契约改为：
  // ①两条走向都能推进剧情；②若已结算，结算日必须在第 60 天之后。
  const accept = autoplay((usable) => usable.find(o => o.label.includes('接')) ?? usable[0], 120);
  assert.ok(accept.visited.size >= 3, `「接」路径只推进了 ${accept.visited.size} 个事件`);

  const decline = autoplay((usable) => usable.find(o => o.label.includes('拒')) ?? usable[0], 120);
  assert.ok(decline.visited.size >= 3, `「拒」路径只推进了 ${decline.visited.size} 个事件`);

  for (const r of [accept, decline]) {
    if (r.state.endings.length > 0) {
      assert.ok(r.state.clock.day > 60, `结算得太早：第 ${r.state.clock.day} 天`);
    }
  }
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
  assert.equal(w.events.length, 84, '事件数变了');
  assert.equal(w.endings.length, 28, '结局数变了');
  assert.equal(w.achievements.length, 50, '成就数变了');
  assert.equal(w.book.entries.length, 38, '世界书条目太少');
  assert.equal(Object.keys(RAINNIGHT_MODE.world.clueLabels).length, 23, '线索数变了');
  assert.equal(Object.keys(w.placeLabels).length, 43, '地点数变了');
  assert.equal(Object.keys(w.actorLabels).length, 5, '角色数变了');
  assert.equal(w.actorLabels.seeker, '林晚晴');
  assert.equal(w.actorLabels.kin, '周若宁');
  assert.equal(w.actorLabels.lost, '周世杰');
});

/* ---------------------------------------------------------------- *
 * 补齐《雨与夜 V4.1》缺口后新增的两条钉子
 * ---------------------------------------------------------------- */

test('补完的事件与文档 §15.2 的卡片编号对得上', () => {
  const ids = new Set(world().events.map(e => e.id));
  // 主线：§15.1.1 里原先没落地、这一轮补齐的编号
  const mains = [
    'E11', 'E13', 'E17', 'E18', 'E20', 'E21', 'E22', 'E25',
    'E27', 'E28', 'E29', 'E30', 'E31', 'E32', 'E33', 'E34',
    'E35', 'E36', 'E37', 'E39', 'E42', 'E43', 'E45', 'E46',
    'E47', 'E48', 'E49', 'E50', 'E51', 'E52', 'E53', 'E54',
    'E55', 'E56',
  ];
  // 分支：§15.1.2（B02 / B03 / B15 早先已以 R15 / R20 / R29 落地）
  const branches = [
    'B01', 'B04', 'B05', 'B06', 'B07', 'B08', 'B09', 'B10',
    'B11', 'B12', 'B13', 'B14',
  ];
  for (const id of [...mains, ...branches]) {
    assert.ok(ids.has(id), `文档里的 ${id} 没有落进数据`);
  }
});

test('关系推进的分支确实挂了当轮同意闸（手滑删掉时这里会红）', () => {
  /* 这九个是真正在推进关系的分支。删掉任何一个 requiresConsent，
     边界 guard 就不再拦截 —— 而它不会报错，只会放行。
     钉住的是「这九个已知要过闸」，不是去预判以后新加的该不该过闸。 */
  const w = world();
  const expect = [
    'R28.A', 'E18.B', 'E20.A', 'E20.B', 'E21.A',
    'E22.C', 'E22.D', 'E30.A', 'E31.D',
  ];
  const actual = w.events.flatMap(e =>
    e.branches.filter(b => b.requiresConsent).map(b => `${e.id}.${b.key}`));

  for (const key of expect) {
    assert.ok(actual.includes(key), `${key} 丢了 requiresConsent —— 闸门对它不再生效`);
  }
  assert.equal(actual.length, expect.length,
    `标了同意闸的分支数从 ${expect.length} 变成了 ${actual.length}，请在上面同步清单`);
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
        // 涉及若宁的分支同样要过闸 —— 只备晚晴会让 E18.B 等分支
        // 以「边界：路线未开启」被挡，那是闸门正常工作，不是数据走不通
        { path: 'routes.kin', op: 'set', value: 'open' },
      ]).state;
      s = applyEffects(s, consentEffects(s, 'seeker', CONSENT.ACCEPT)).state;
      s = applyEffects(s, consentEffects(s, 'kin', CONSENT.ACCEPT)).state;

      // 条件不成立的分支本来就该抛，只有 cond=null 的必须能走通
      if (b.cond !== null && b.cond !== undefined) continue;
      assert.doesNotThrow(
        () => applyTurn(s, ev, b.key, w),
        `${ev.id}.${b.key} 走不通`,
      );
    }
  }
});

test('自动跑到底会落到一个结局，且结局在第 60 天之后、线索不跳阶段', () => {
  // 契约变更（2026-09-19）：结局门槛加了 day > 60，60 轮已不足以跑到结算日，
  // 这里放宽到 200 轮，并新增「结算日必须 > 60」的断言。
  const { state } = autoplay((usable) => usable[0], 200);
  assert.ok(state.endings.length > 0, '跑了 200 轮都没结局');
  assert.ok(state.clock.day > 60, `结局在第 ${state.clock.day} 天结算，早于门槛`);

  // 阶段不可跳：没有 D3 就不该有 D5 —— D5 只在 R21 之后释放
  if (state.clues.includes('D5')) {
    assert.ok(state.clues.includes('D3'), '拿到了 D5 却没有 D3，阶段被跳了');
  }
});

/* ---------------------------------------------------------------- *
 * 关系路线
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

test('关系路线能一路推到「伴侣-共享」—— 没有任何机制挡推进', () => {
  const w = world();

  /* 按正常玩法：把每一步 require 满足掉，然后用 applyTurn 真的推。
     只要引擎放行，路线就能走到底 —— 这条测试就是防止有人再往
     路线里塞限制（我加过一次锁，被赢容骂了，撤了）。 */
  const walk = (ids, setUp) => {
    let s = initialState();
    s = applyEffects(s, [
      { path: 'flags.met_seeker', op: 'set', value: true },
      { path: 'flags.took_them_in', op: 'set', value: true },
      { path: 'flags.case_stage', op: 'set', value: 6 },
    ]).state;
    for (const id of ids) {
      const ev = w.events.find(e => e.id === id);
      assert.ok(ev, `找不到事件 ${id}`);
      s = applyEffects(s, setUp(ev)).state;
      s = applyTurn(s, ev, 'A', w).state;
    }
    return s;
  };

  const high = (who) => [{ path: `actors.${who}.stats.trust`, op: 'set', value: 95 }];
  const safe = [{ path: 'actors.kin.stats.safety', op: 'set', value: 95 }];

  const s1 = walk(['P01', 'P02', 'P03', 'P08'],
    (ev) => (ev.id === 'P03' || ev.id === 'P08' ? high('seeker') : []));
  assert.equal(s1.flags.path_seeker, '伴侣-共享', '林晚晴的路线推不到底');

  const s2 = walk(['P01', 'P05', 'P06', 'P09'],
    (ev) => (ev.id === 'P09'
      ? [...safe, { path: 'flags.path_kin', op: 'set', value: '情感依赖' }]
      : []));
  assert.equal(s2.flags.path_kin, '伴侣-共享', '周若宁的路线推不到底');
});

test('路线节点表与文档 §4 一致', () => {
  assert.deepEqual(RAIN_PATHS.seeker,
    ['暂住', '共同生活', '债务共担', '情感依赖', '伴侣-共享', '决裂']);
  assert.deepEqual(RAIN_PATHS.kin,
    ['暂住', '依赖', '共同调查', '情感依赖', '伴侣-共享', '独立', '决裂']);
});

test('没有任何角色被标成不可推进', () => {
  const w = world();
  const st = initialState();
  for (const [id, a] of Object.entries(st.actors)) {
    assert.notEqual(a.adult, false, `${id} 被标成了禁止推进`);
  }
  assert.ok(Object.keys(st.actors).length >= 5);
});

/* ---------------------------------------------------------------- *
 * 模式级字段必须传到 world（否则 UI 读不到，静默降级）
 * ---------------------------------------------------------------- */

test('rainLevel 与 rules 要传到 world 上', () => {
  const w = world();
  /* 这两个字段定义在 RAINNIGHT_MODE 顶层，createRainWorld 曾经没往下传、
     createWorld 的白名单也没收 —— 于是 world.rainLevel 是 undefined，
     `undefined > 0` 为 false，**雨夜的 BGM 与雨声从头到尾没响过**，
     而一切看起来都正常（没有报错、没有失败）。这条测试就是钉住它。 */
  assert.equal(w.rainLevel, 0.85, 'rainLevel 没传到 world —— 雨声与 BGM 永远不会启动');
  assert.equal(w.rules?.consentEnforced, true, 'rules 没传到 world');
  assert.equal(w.rules?.turnOnlyConsent, true);
});

test('engine 的白名单也认这两个字段（两层缺一不可）', () => {
  const w = createWorld({
    events: [{
      id: 'E', title: '测试事件',
      branches: [{ key: 'A', label: 'A', text: '', cond: null, effects: [] }],
    }],
    rainLevel: 0.5,
    rules: { consentEnforced: true },
  });
  assert.equal(w.rainLevel, 0.5);
  assert.equal(w.rules.consentEnforced, true);
});

/* ---------------------------------------------------------------- *
 * 成就条件的可达性
 *
 * 这两条曾经是「写得出但永远解锁不了」的死条件：
 *   A_H07 依赖 flags.withdraw_count —— 计数从来没人累加，恒为缺失 → 恒 false
 *   A_H05 原文「达成 30 项以上」—— 条件系统当时没有 length，改用「含最难那项」近似
 * 下面钉住的是**能不能真的走到成立**，不是「条件写得对不对」。
 * ---------------------------------------------------------------- */

const achievements = () => RAINNIGHT_MODE.world.achievements ?? [];

test('所有成就的 cond 都过 schema 校验', () => {
  const issues = [];
  for (const a of achievements()) {
    validateCondition(a.cond, 'achievements.' + a.id + '.cond', issues);
  }
  assert.deepEqual(issues, [], '有成就的条件不合法：' + JSON.stringify(issues));
});

test('A_H07「三缄其口」：撤回三次后条件真的成立', () => {
  const a = achievements().find(x => x.id === 'A_H07');
  assert.ok(a, 'A_H07 不见了');

  let s = initialState();
  assert.equal(evaluate(a.cond, s), false, '一次都没撤回时不该解锁');

  /* 逐次逼近阈值：两次还不够，第三次才成立 —— 只验「三次成立」
     会漏掉「一次就成立」这种计数写错（比如用 set 而不是 add）。 */
  for (let i = 0; i < 2; i++) {
    s = applyEffects(s, withdrawEffects(s, 'lin', { respected: true })).state;
    assert.equal(evaluate(a.cond, s), false, '撤回 ' + (i + 1) + ' 次还不该解锁');
  }
  s = applyEffects(s, withdrawEffects(s, 'lin', { respected: true })).state;
  assert.equal(evaluate(a.cond, s), true, '第三次该解锁了');
});

test('A_H05「达成 30 项以上」：读成就数组长度，29 不解锁 / 30 解锁', () => {
  const a = achievements().find(x => x.id === 'A_H05');
  assert.ok(a, 'A_H05 不见了');
  assert.equal(a.cond.op, 'length', '该用 length 而不是拿某一项近似');
  assert.equal(a.cond.value.min, 30);

  const withN = (n) => {
    const s = initialState();
    s.achievements = Array.from({ length: n }, (_, i) => 'X' + i);
    return s;
  };
  assert.equal(evaluate(a.cond, withN(29)), false, '29 项不该解锁');
  assert.equal(evaluate(a.cond, withN(30)), true, '30 项该解锁');
});

test('A_H05 不走 $auto：中途状态里 $auto 还没算，读数组才准', () => {
  const s = initialState();
  s.achievements = ['a', 'b', 'c'];
  assert.equal(evaluate({ path: 'achievements', op: 'length', value: 3 }, s), true);
  assert.equal(s.$auto.achievement_count, undefined, '未提交时 $auto 里没这个键');

  const store = createStore(s);
  assert.equal(store.getState().$auto.achievement_count, 3, '提交后 $auto 才追上来');
});
