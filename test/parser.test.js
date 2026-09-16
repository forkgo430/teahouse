import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoWorld, createDemoState, EVENTS } from '../data/demo.js';
import { nextTurn, applyTurn, interpretInput, buildOptions, TurnRejected } from '../src/engine.js';
import {
  AUTO_WORDS,
  normalizeText,
  matchBranch,
  isAutoIntent,
  parseInput,
  suggestPhrases,
} from '../src/parser.js';
import { hashState } from '../src/state.js';

/* ---------------------------------------------------------------- *
 * 夹具
 * ---------------------------------------------------------------- */

const E01 = EVENTS.find(e => e.id === 'E01');
const E07 = EVENTS.find(e => e.id === 'E07');

function fresh() {
  const world = createDemoWorld();
  const state = createDemoState();
  const opened = nextTurn(state, world);
  return { world, state: opened.state, event: opened.event, options: opened.options };
}

/* ---------------------------------------------------------------- *
 * 归一化
 * ---------------------------------------------------------------- */

test('normalizeText 转小写、压空白、全角转半角', () => {
  assert.equal(normalizeText('  Open  THE  Door '), 'open the door');
  assert.equal(normalizeText('开　门'), '开 门');
  assert.equal(normalizeText(123), '');
  assert.equal(normalizeText(null), '');
});

/* ---------------------------------------------------------------- *
 * 关键词匹配
 * ---------------------------------------------------------------- */

test('命中分支显式声明的关键词', () => {
  const hit = matchBranch('我想开门', E01);
  assert.equal(hit.branchKey, 'A');
  assert.ok(hit.matched.includes('开门'));
});

test('命中分支 label（玩家的说法与原选项一致时）', () => {
  const hit = matchBranch('我决定装作没听见', E01);
  assert.equal(hit.branchKey, 'B');
});

test('否定词拦掉错误的匹配', () => {
  // 「我不想开门」不应该匹配到「开门」
  const hit = matchBranch('我不想开门', E01);
  assert.notEqual(hit?.branchKey, 'A');
});

test('否定词只影响被否定的那个候选', () => {
  // 「不开门，我从猫眼看」→ 应落到 C
  const hit = matchBranch('不开门 我从猫眼看', E01);
  assert.equal(hit?.branchKey, 'C');
});

test('匹配不上时返回 null，不做兜底猜测', () => {
  assert.equal(matchBranch('今天天气不错', E01), null);
  assert.equal(matchBranch('', E01), null);
});

test('多分支竞争时取更长更具体的命中', () => {
  // E07 的 B 有 keyword「查清楚」，C 有「搬走」。说全句应命中对应分支
  assert.equal(matchBranch('我决定留下查清楚', E07).branchKey, 'B');
  assert.equal(matchBranch('天亮就搬家', E07).branchKey, 'C');
});

test('关键词权重高于 label（同长度时关键词胜）', () => {
  // 构造一个人为竞争：两个分支都说「看」，但其中一个显式声明为关键词
  const ev = {
    branches: [
      { key: 'A', label: '看一眼', keywords: [], cond: null, text: '' },
      { key: 'B', label: '随便', keywords: ['看一眼'], cond: null, text: '' },
    ],
  };
  assert.equal(matchBranch('看一眼', ev).branchKey, 'B');
});

test('匹配结果确定：同一输入重复调用结果一致', () => {
  const results = new Set();
  for (let i = 0; i < 15; i++) results.add(matchBranch('我想开门', E01).branchKey);
  assert.deepEqual([...results], ['A']);
});

/* ---------------------------------------------------------------- *
 * 放权意图
 * ---------------------------------------------------------------- */

test('空输入视为放权', () => {
  assert.equal(isAutoIntent(''), true);
  assert.equal(isAutoIntent('   '), true);
});

test('「随便」「你决定」这类说法视为放权', () => {
  for (const word of ['随便', '都行', '你决定', '继续', '随意']) {
    assert.equal(isAutoIntent(word), true, `${word} 应视为放权`);
  }
  assert.ok(AUTO_WORDS.includes('随便'));
});

test('具体动作不会被误判为放权', () => {
  assert.equal(isAutoIntent('开门'), false);
  assert.equal(isAutoIntent('我想报警'), false);
});

/* ---------------------------------------------------------------- *
 * parseInput
 * ---------------------------------------------------------------- */

test('parseInput 返回三种意图', () => {
  assert.equal(parseInput('随便', E01).kind, 'auto');
  assert.equal(parseInput('开门', E01).kind, 'branch');
  assert.equal(parseInput('随便说点什么', E01).kind, 'auto');
  assert.equal(parseInput('天气真好', E01).kind, 'unknown');
});

test('parseInput 带回命中的词，便于回执', () => {
  const r = parseInput('我想开门看看', E01);
  assert.equal(r.kind, 'branch');
  assert.ok(r.matched.length > 0);
  assert.ok(r.score > 0);
});

test('suggestPhrases 给出可说法', () => {
  const list = suggestPhrases(E01, null);
  assert.equal(list.length, E01.branches.length);
  assert.ok(list[0].includes('开门'));

  const onlyA = suggestPhrases(E01, ['A']);
  assert.equal(onlyA.length, 1);
});

/* ---------------------------------------------------------------- *
 * interpretInput（引擎层）
 * ---------------------------------------------------------------- */

test('空输入 → auto', () => {
  const { state, event } = fresh();
  assert.equal(interpretInput(state, event, undefined).kind, 'auto');
  assert.equal(interpretInput(state, event, '').kind, 'auto');
  assert.equal(interpretInput(state, event, { auto: true }).kind, 'auto');
});

test('分支 key 精确命中（大小写不敏感）', () => {
  const { state, event } = fresh();
  assert.equal(interpretInput(state, event, 'A').branchKey, 'A');
  assert.equal(interpretInput(state, event, 'b').branchKey, 'B');
});

test('序号映射到选项列表', () => {
  const { state, event } = fresh();
  assert.equal(interpretInput(state, event, '1').branchKey, 'A');
  assert.equal(interpretInput(state, event, '2').branchKey, 'B');
});

test('序号超出范围时给出明确原因', () => {
  const { state, event } = fresh();
  const r = interpretInput(state, event, '9');
  assert.equal(r.kind, 'unknown');
  assert.match(r.reason, /没有第 9 个选项/);
});

test('序号指向不可用选项时标记 unavailable', () => {
  const { state, event } = fresh();
  // E01 的 C 需要「未见过老陈」，初始状态下不成立
  const r = interpretInput(state, event, '3');
  assert.equal(r.kind, 'unavailable');
  assert.equal(r.branchKey, 'C');
  assert.ok(r.reason);
});

test('自然语言走解析器', () => {
  const { state, event } = fresh();
  const r = interpretInput(state, event, '我想开门');
  assert.equal(r.kind, 'key');
  assert.equal(r.branchKey, 'A');
  assert.ok(r.matched.includes('开门'));
});

test('说不相关的话 → unknown，并附上可说法', () => {
  const { state, event } = fresh();
  const r = interpretInput(state, event, '窗外有只猫');
  assert.equal(r.kind, 'unknown');
  assert.ok(Array.isArray(r.suggestions));
  assert.ok(r.suggestions.length > 0);
});

test('不存在的 key 仍走 key 通道（保持原有报错语义）', () => {
  const { state, event } = fresh();
  assert.deepEqual(interpretInput(state, event, 'ZZZ'), { kind: 'key', branchKey: 'ZZZ' });
});

/* ---------------------------------------------------------------- *
 * 端到端
 * ---------------------------------------------------------------- */

test('applyTurn 接受自然语言输入', () => {
  const { world, state, event } = fresh();
  const { state: after, report } = applyTurn(state, event, '我想开门', world);
  assert.equal(report.branchKey, 'A');
  assert.equal(report.intent.kind, 'key');
  assert.equal(after.flags.met_keeper, true);
});

test('applyTurn 接受序号', () => {
  const { world, state, event } = fresh();
  const { report } = applyTurn(state, event, '2', world);
  assert.equal(report.branchKey, 'B');
});

test('applyTurn 对「随便」走保底分支', () => {
  const { world, state, event } = fresh();
  const { report } = applyTurn(state, event, '随便吧', world);
  assert.equal(report.intent.kind, 'auto');
  assert.equal(report.branchKey, 'A', 'E01 的保底是 A');
});

test('无理输入被拒且状态不变', () => {
  const { world, state, event } = fresh();
  const before = hashState(state);
  assert.throws(() => applyTurn(state, event, '窗外有只猫', world), (e) => {
    assert.ok(e instanceof TurnRejected);
    assert.equal(e.detail.reason, 'unknown-input');
    assert.ok(e.detail.suggestions.length > 0, '拒绝时要告诉玩家可以怎么说');
    return true;
  });
  assert.equal(hashState(state), before);
});

test('自然语言与点选走的是同一条分支', () => {
  const { world, state, event } = fresh();
  const byWord = applyTurn(state, event, '我开门', world).state;
  const byKey = applyTurn(state, event, 'A', world).state;

  assert.equal(byWord.history[0].branchKey, byKey.history[0].branchKey);
  // history 会记下玩家原话，所以整体指纹必然不同 —— 比对时要把它摘掉
  assert.equal(byWord.history[0].said, '我开门');
  assert.equal(byKey.history[0].said, null);

  const strip = (s) => JSON.stringify({ ...s, history: s.history.map(({ said, ...rest }) => rest) });
  assert.equal(strip(byWord), strip(byKey), '落到状态上的结果必须一致');
});

test('否定式输入不会被当成肯定动作', () => {
  const { world, state, event } = fresh();
  const r = interpretInput(state, event, '我不想开门');
  assert.notEqual(r.branchKey, 'A', '「不想开门」不能走成开门');
});

test('report 里带上玩家原话，便于回执展示', () => {
  const { world, state, event } = fresh();
  const { report } = applyTurn(state, event, '我想开门', world);
  assert.equal(report.intent.raw, '我想开门');
});

test('自由输入不破坏原有的 key 通路', () => {
  const { world, state, event } = fresh();
  assert.throws(() => applyTurn(state, event, 'ZZZ', world), (e) => {
    assert.equal(e.detail.reason, 'unknown-branch');
    return true;
  });
});
