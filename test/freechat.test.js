import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFreeMessages, parseSegments, segmentsToText, personaLines, pickSpeakers,
  placePersona,
} from '../src/freechat.js';

/* ---------------------------------------------------------------- *
 * 分段
 * ---------------------------------------------------------------- */

test('群聊分段：带名字的开新段，没有名字的行并进当前段', () => {
  const raw = '【林晚晴】她把伞收了，靠在门边。\n'
    + '雨水顺着伞骨滴下来。\n'
    + '【周若宁】「我不冷。」';
  const segs = parseSegments(raw, { known: ['林晚晴', '周若宁'] });

  assert.equal(segs.length, 2);
  assert.equal(segs[0].speaker, '林晚晴');
  assert.match(segs[0].text, /她把伞收了/);
  assert.match(segs[0].text, /雨水顺着伞骨/, '后续行应并进同一段');
  assert.equal(segs[1].speaker, '周若宁');
  assert.equal(segs[1].text, '「我不冷。」');
});

test('一个标记都没有时，整段当叙述（speaker 为 null）', () => {
  const segs = parseSegments('门外站了两个人，都湿透了。', { known: ['林晚晴'] });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].speaker, null);
  assert.equal(segs[0].text, '门外站了两个人，都湿透了。');
});

test('不在名单里的【】不当角色（比如【旁白】）', () => {
  const segs = parseSegments('【旁白】雨还在下。\n【林晚晴】进来吧。', { known: ['林晚晴'] });
  assert.equal(segs.length, 2);
  // 「旁白」不是角色 → 整行留在叙述段里（标记也不剥掉，它本来就是文本）
  assert.equal(segs[0].speaker, null);
  assert.match(segs[0].text, /旁白/);
  // 名单里的角色照常独立成段
  assert.equal(segs[1].speaker, '林晚晴');
  assert.equal(segs[1].text, '进来吧。');
});

test('空输出不产生段', () => {
  assert.deepEqual(parseSegments('', {}), []);
  assert.deepEqual(parseSegments('   \n  ', {}), []);
});

test('segmentsToText 能还原成可存档的纯文本', () => {
  const segs = [{ speaker: '林晚晴', text: '好。' }, { speaker: null, text: '灯灭了。' }];
  assert.equal(segmentsToText(segs), '【林晚晴】好。\n\n灯灭了。');
});

/* ---------------------------------------------------------------- *
 * 提示词组装
 * ---------------------------------------------------------------- */

test('persona 为空时不产生任何提示行', () => {
  assert.equal(personaLines(null), '');
  assert.equal(personaLines({ name: '', desc: '  ' }), '');
  assert.match(personaLines({ name: '林晚晴' }), /林晚晴/);
  assert.match(personaLines({ name: '林晚晴', desc: '19 岁' }), /19 岁/);
});

test('群聊开时要求按【角色名】分段；关时不要求', () => {
  const base = { brief: 'B', playerText: '在吗', actors: [{ name: '林晚晴' }, { name: '周若宁' }] };
  const on = buildFreeMessages({ ...base, group: true })[0].content;
  const off = buildFreeMessages({ ...base, group: false })[0].content;

  assert.match(on, /【林晚晴】/, '群聊应给出分段格式示例');
  assert.match(on, /林晚晴、周若宁/, '群聊应列出在场角色');
  assert.doesNotMatch(off, /分段/, '非群聊不该要求分段');
  assert.match(off, /林晚晴、周若宁/, '非群聊也要知道在场有谁');
});

test('history 转成 user/assistant 轮次，最后一条是玩家刚说的', () => {
  const msgs = buildFreeMessages({
    brief: 'B',
    history: [
      { said: '我开门了', text: '门开了，两个人站在外面。' },
      { said: null, text: '雨还没停。' },
    ],
    playerText: '你们进来吧',
  });

  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[1].content, '我开门了');
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs.at(-1).role, 'user');
  assert.equal(msgs.at(-1).content, '你们进来吧');
});

test('不替玩家发言：提示词里明确禁止', () => {
  const sys = buildFreeMessages({ brief: 'B', playerText: 'x' })[0].content;
  assert.match(sys, /不要替玩家发言/);
});

/* ---------------------------------------------------------------- *
 * 谁开口（做法参考酒馆的 activation_strategy）
 * ---------------------------------------------------------------- */

const CAST = [{ name: '林晚晴' }, { name: '周若宁' }, { name: '周世杰' }];

test('natural：点到谁的名字就谁答', () => {
  const got = pickSpeakers({ actors: CAST, playerText: '林晚晴，你怎么想？', strategy: 'natural' });
  assert.deepEqual(got.map(a => a.name), ['林晚晴']);
});

test('natural：谁都没点到时，在场全体（排除刚说过的那个）', () => {
  const got = pickSpeakers({
    actors: CAST, playerText: '外面还在下雨。', strategy: 'natural', lastSpeaker: '周若宁',
  });
  assert.deepEqual(got.map(a => a.name), ['林晚晴', '周世杰']);
});

test('list：在场全体都激活', () => {
  const got = pickSpeakers({ actors: CAST, playerText: '随便', strategy: 'list', lastSpeaker: '周若宁' });
  assert.deepEqual(got.map(a => a.name), ['林晚晴', '周若宁', '周世杰']);
});

test('manual：只挑一个，且不挑刚说过话的', () => {
  for (let i = 0; i < 20; i += 1) {
    const got = pickSpeakers({ actors: CAST, playerText: '', strategy: 'manual', lastSpeaker: '林晚晴' });
    assert.equal(got.length, 1);
    assert.notEqual(got[0].name, '林晚晴');
    assert.ok(CAST.map(a => a.name).includes(got[0].name));
  }
});

test('allowSelf 打开后，刚说过话的也能再接', () => {
  const got = pickSpeakers({
    actors: [{ name: '林晚晴' }], playerText: '嗯', strategy: 'natural', lastSpeaker: '林晚晴',
  });
  assert.deepEqual(got.map(a => a.name), ['林晚晴'], '只有一个人在场时必须让他说，不能返回空');

  const off = pickSpeakers({
    actors: [{ name: '林晚晴' }, { name: '周若宁' }],
    playerText: '嗯', strategy: 'natural', lastSpeaker: '林晚晴', allowSelf: false,
  });
  assert.deepEqual(off.map(a => a.name), ['周若宁']);
});

test('disabled 的角色不参与', () => {
  const got = pickSpeakers({
    actors: [{ name: '林晚晴', disabled: true }, { name: '周若宁' }],
    playerText: '林晚晴？', strategy: 'natural',
  });
  assert.deepEqual(got.map(a => a.name), ['周若宁']);
});

test('群聊时提示词里写明这一轮该谁回应', () => {
  const sys = buildFreeMessages({
    brief: 'B', playerText: 'x', group: true,
    actors: CAST, speakers: ['林晚晴'],
  })[0].content;
  assert.match(sys, /这一轮请让这些角色回应：林晚晴/);
});

/* ---------------------------------------------------------------- *
 * 玩家设定放在哪（参考酒馆 persona 的 position / depth / role）
 * ---------------------------------------------------------------- */

const PERSONA = { name: '我', desc: '三十岁，做装修的' };

test('默认位置：设定拼进 system，消息条数不变', () => {
  const msgs = buildFreeMessages({ brief: 'B', playerText: '在吗', persona: PERSONA });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /玩家扮演：我/);
});

test('top：设定单独一条放在最前', () => {
  const msgs = buildFreeMessages({ playerText: '在吗', persona: { ...PERSONA, position: 'top' } });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /玩家扮演：我/);
  assert.equal(msgs[msgs.length - 1].content, '在吗');
});

test('bottom：设定紧贴玩家这句话之前', () => {
  const msgs = buildFreeMessages({
    brief: 'B', history: [{ said: '上一句', text: '上一答' }],
    playerText: '在吗', persona: { ...PERSONA, position: 'bottom' },
  });
  const idx = msgs.findIndex(m => /玩家扮演：我/.test(m.content));
  assert.equal(idx, msgs.length - 2, '设定应紧贴在最后那句之前');
  assert.equal(msgs[msgs.length - 1].content, '在吗');
});

test('at-depth：插在距末尾 depth 条处', () => {
  const history = [];
  for (let i = 1; i <= 5; i += 1) history.push({ said: `问${i}`, text: `答${i}` });
  const msgs = buildFreeMessages({
    brief: 'B', history, playerText: '在吗',
    persona: { ...PERSONA, position: 'at-depth', depth: 2 },
  });
  // system + 5×2 + user = 12 条；depth 2 → 插在 index 10（倒数第 3 条）
  assert.equal(msgs.length, 13);
  assert.match(msgs[msgs.length - 3].content, /玩家扮演：我/);
});

test('at-depth 再深也不会挤到 system 前面', () => {
  const msgs = buildFreeMessages({
    brief: 'B', playerText: '在吗',
    persona: { ...PERSONA, position: 'at-depth', depth: 99 },
  });
  assert.equal(msgs[0].role, 'system');
  assert.doesNotMatch(msgs[0].content, /玩家扮演：我/, 'system 位应由 brief 占着');
  assert.match(msgs[1].content, /玩家扮演：我/);
});

test('role 可选 user / assistant', () => {
  const asUser = buildFreeMessages({ playerText: 'x', persona: { ...PERSONA, position: 'top', role: 'user' } });
  assert.equal(asUser[0].role, 'user');
  const bogus = buildFreeMessages({ playerText: 'x', persona: { ...PERSONA, position: 'top', role: '上帝' } });
  assert.equal(bogus[0].role, 'system', '非法 role 退回 system');
});

test('没填设定时，位置设置不产生空消息', () => {
  for (const position of ['in-prompt', 'top', 'bottom', 'at-depth']) {
    const msgs = buildFreeMessages({ brief: 'B', playerText: '在吗', persona: { name: '', desc: '', position } });
    assert.equal(msgs.length, 2, `${position} 多出空消息`);
  }
});

test('被禁用的成员不会出现在这一轮的发言名单里', () => {
  const got = pickSpeakers({
    actors: [{ id: 'a', name: '林晚晴' }, { id: 'b', name: '周若宁', disabled: true }],
    playerText: '周若宁，你说', strategy: 'natural',
  });
  assert.deepEqual(got.map(a => a.name), ['林晚晴'], '点名了也不该让被禁用的开口');
});
