import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoWorld, createDemoState } from '../data/demo.js';
import { nextTurn, applyTurn } from '../src/engine.js';
import { createDirector } from '../src/director.js';
import { LLMError } from '../src/llm.js';

/* ---------------------------------------------------------------- *
 * 替身
 * ---------------------------------------------------------------- */

function mockClient({ ready = true, complete = null, stream = null } = {}) {
  return {
    ready: () => ready,
    describe: () => ({ ready, endpoint: 'mock://x', model: 'mock', hasKey: ready }),
    complete: complete ?? (async () => { throw new LLMError('未设桩', { code: 'noop' }); }),
    stream: stream ?? (async () => { throw new LLMError('未设桩', { code: 'noop' }); }),
  };
}

function setup() {
  const world = createDemoWorld();
  const opened = nextTurn(createDemoState(), world);
  return { world, state: opened.state, event: opened.event, options: opened.options };
}

/* ---------------------------------------------------------------- *
 * 无模型：全部走本地
 * ---------------------------------------------------------------- */

test('无模型时 hasModel 为 false', () => {
  const { world } = setup();
  assert.equal(createDirector({ world }).hasModel(), false);
  assert.equal(createDirector({ world, client: mockClient({ ready: false }) }).hasModel(), false);
});

test('无模型时本地命中关键词仍然可用', async () => {
  const { world, state, event, options } = setup();
  const director = createDirector({ world });

  const r = await director.resolveBranch(state, event, options, '我想开门');
  assert.equal(r.ok, true);
  assert.equal(r.source, 'local');
  assert.equal(r.branchKey, 'A');
});

test('无模型时本地不中就是认输，不猜', async () => {
  const { world, state, event, options } = setup();
  const r = await createDirector({ world }).resolveBranch(state, event, options, '窗外有只猫');
  assert.equal(r.ok, false);
  assert.equal(r.source, 'none');
  assert.equal(r.branchKey, null);
});

test('无模型时叙事直接用预写文本', async () => {
  const { world, state, event } = setup();
  const branch = event.branches.find(b => b.key === 'A');
  const { state: after, report } = applyTurn(state, event, 'A', world);

  const r = await createDirector({ world }).narrate({
    state: after, event, branch, report, playerInput: '',
  });
  assert.equal(r.source, 'scripted');
  assert.equal(r.text, branch.text);
});

/* ---------------------------------------------------------------- *
 * 本地优先：有模型也不乱调
 * ---------------------------------------------------------------- */

test('本地能判出来就不问模型（省一次调用）', async () => {
  let called = 0;
  const client = mockClient({
    complete: async () => { called += 1; return '{"branchKey":"B"}'; },
  });
  const { world, state, event, options } = setup();

  const r = await createDirector({ world, client }).resolveBranch(state, event, options, '开门');
  assert.equal(r.branchKey, 'A');
  assert.equal(called, 0, '不该调用模型');
});

/* ---------------------------------------------------------------- *
 * 模型兜底
 * ---------------------------------------------------------------- */

test('本地不中时让模型在可用选项里选', async () => {
  const client = mockClient({
    complete: async (messages) => {
      const user = messages[1].content;
      assert.match(user, /可选做法/);
      assert.match(user, /门外有人/);
      return '```json\n{"branchKey":"B","confidence":0.8,"reason":"玩家表示不想理会"}\n```';
    },
  });
  const { world, state, event, options } = setup();

  const r = await createDirector({ world, client }).resolveBranch(state, event, options, '门外那人敲得挺执着但我今天实在没力气应付');
  assert.equal(r.ok, true);
  assert.equal(r.source, 'model');
  assert.equal(r.branchKey, 'B');
  assert.match(r.note, /不想理会/);
});

test('模型给出不在候选里的选项时视为失败', async () => {
  const client = mockClient({ complete: async () => '{"branchKey":"Z","confidence":0.9}' });
  const { world, state, event, options } = setup();

  const r = await createDirector({ world, client }).resolveBranch(state, event, options, '门外那人的脚步声很急');
  assert.equal(r.ok, false);
  assert.equal(r.source, 'none');
});

test('模型调用失败时不抛给界面，返回 ok:false 并带上错误', async () => {
  const client = mockClient({
    complete: async () => { throw new LLMError('接口返回 429', { code: 'http', status: 429 }); },
  });
  const { world, state, event, options } = setup();

  const r = await createDirector({ world, client }).resolveBranch(state, event, options, '门外那人的脚步声很急');
  assert.equal(r.ok, false);
  assert.ok(r.error instanceof LLMError);
  assert.equal(r.error.detail.status, 429);
});

test('模型返回空对象时视为失败', async () => {
  const client = mockClient({ complete: async () => '{"branchKey":null,"confidence":0}' });
  const { world, state, event, options } = setup();
  const r = await createDirector({ world, client }).resolveBranch(state, event, options, '门外那人的脚步声很急');
  assert.equal(r.ok, false);
});

test('「随便」这类放权说法不需要模型参与', async () => {
  let called = 0;
  const client = mockClient({ complete: async () => { called += 1; return '{}'; } });
  const { world, state, event, options } = setup();

  const r = await createDirector({ world, client }).resolveBranch(state, event, options, '你决定吧');
  assert.equal(r.source, 'auto');
  assert.equal(r.branchKey, null);
  assert.equal(called, 0);
});

test('条件不满足的分支被交给引擎去报错，不偷偷换一个', async () => {
  let called = 0;
  const client = mockClient({ complete: async () => { called += 1; return '{}'; } });
  const { world, state, event, options } = setup();

  // E01 的 C 需要「尚未见过老陈」的反面，初始不成立
  const r = await createDirector({ world, client }).resolveBranch(state, event, options, '猫眼');
  assert.equal(r.ok, true);
  assert.equal(r.branchKey, 'C');
  assert.equal(called, 0);
});

/* ---------------------------------------------------------------- *
 * 叙事生成
 * ---------------------------------------------------------------- */

test('有模型时用模型正文，并报告来源', async () => {
  const client = mockClient({
    complete: async () => '你拧开锁。门外站着管理员老陈。',
  });
  const { world, state, event } = setup();
  const branch = event.branches.find(b => b.key === 'A');
  const { state: after, report } = applyTurn(state, event, 'A', world);

  const r = await createDirector({ world, client }).narrate({
    state: after, event, branch, report, playerInput: '开门',
  });
  assert.equal(r.source, 'model');
  assert.equal(r.text, '你拧开锁。门外站着管理员老陈。');
});

test('模型正文经清洗后才交给界面', async () => {
  const client = mockClient({ complete: async () => '```\n{"text":"门开了。"}\n```' });
  const { world, state, event } = setup();
  const branch = event.branches.find(b => b.key === 'A');
  const { state: after, report } = applyTurn(state, event, 'A', world);

  const r = await createDirector({ world, client }).narrate({
    state: after, event, branch, report, playerInput: '',
  });
  assert.equal(r.text, '门开了。');
});

test('叙事失败时回落到预写文本，游戏不中断', async () => {
  const client = mockClient({
    complete: async () => { throw new LLMError('请求超时或被取消', { code: 'timeout' }); },
  });
  const { world, state, event } = setup();
  const branch = event.branches.find(b => b.key === 'A');
  const { state: after, report } = applyTurn(state, event, 'A', world);

  const r = await createDirector({ world, client }).narrate({
    state: after, event, branch, report, playerInput: '',
  });
  assert.equal(r.source, 'scripted');
  assert.equal(r.text, branch.text);
  assert.equal(r.error.detail.code, 'timeout');
});

test('模型返回空正文也回落', async () => {
  const client = mockClient({ complete: async () => '   ' });
  const { world, state, event } = setup();
  const branch = event.branches.find(b => b.key === 'B');
  const { state: after, report } = applyTurn(state, event, 'B', world);

  const r = await createDirector({ world, client }).narrate({
    state: after, event, branch, report, playerInput: '',
  });
  assert.equal(r.source, 'scripted');
  assert.equal(r.error.detail.code, 'empty');
});

test('流式生成时把增量交给回调', async () => {
  const seen = [];
  const client = mockClient({
    stream: async (_messages, _options, onDelta) => {
      const pieces = ['你', '推开', '门。'];
      let full = '';
      for (const p of pieces) {
        full += p;
        onDelta(p, full);
      }
      return full;
    },
  });
  const { world, state, event } = setup();
  const branch = event.branches.find(b => b.key === 'A');
  const { state: after, report } = applyTurn(state, event, 'A', world);

  const r = await createDirector({ world, client, onDelta: (partial) => seen.push(partial) }).narrate({
    state: after, event, branch, report, playerInput: '',
  });

  assert.equal(r.source, 'model');
  assert.equal(r.text, '你推开门。');
  assert.ok(seen.length >= 3, '至少收到三次增量');
  assert.equal(seen.at(-1), '你推开门。');
});

test('叙事提示词里带上了既成事实（模型不会写出矛盾细节）', async () => {
  let captured = null;
  const client = mockClient({
    complete: async (messages) => { captured = messages[1].content; return '正文。'; },
  });
  const { world, state, event } = setup();
  const branch = event.branches.find(b => b.key === 'A');
  const { state: after, report } = applyTurn(state, event, 'A', world);

  await createDirector({ world, client }).narrate({
    state: after, event, branch, report, playerInput: '开门',
  });

  assert.match(captured, /既成事实/);
  assert.match(captured, /老陈（管理员）的信任/);
});

test('describe 在无模型时给出 ready:false', () => {
  const { world } = setup();
  assert.deepEqual(createDirector({ world }).describe(), { ready: false });
  assert.equal(createDirector({ world, client: mockClient() }).describe().ready, true);
});
