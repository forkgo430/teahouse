import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFreeMessages, parseSegments, segmentsToText, personaLines,
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
