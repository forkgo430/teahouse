import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseActions, parseEffectSpec, formatActions, DEFAULT_ACTIONS_TEXT, ACTION_KINDS, BUILTIN_ACTIONS,
} from '../src/actions.js';

/* 快捷动作只抄 STscript 的**交互形态**（按钮），不抄它的语言。
   所以这里测的是：文本能不能稳稳解析成动作、非法行有没有被吞掉。 */

test('一行一条：say / effect / builtin 三种都能解出来', () => {
  const { actions, issues } = parseActions(DEFAULT_ACTIONS_TEXT);
  assert.equal(issues.length, 0, `示例自身就报错了：${JSON.stringify(issues)}`);
  const kinds = new Set(actions.map(a => a.kind));
  for (const k of kinds) assert.ok(ACTION_KINDS.includes(k));
  assert.ok(actions.some(a => a.kind === 'builtin' && a.builtin === 'save'));
  assert.ok(actions.some(a => a.kind === 'say' && a.label === '喝口热水' && a.text.includes('烧了壶水')));
  assert.ok(actions.some(a => a.kind === 'effect' && a.effects[0].path === 'actors.seeker.stats.pressure'));
});

test('注释与空行被跳过，不算错误', () => {
  const { actions, issues } = parseActions('# 注释\n\n   \n存个档 | builtin | save');
  assert.equal(issues.length, 0);
  assert.equal(actions.length, 1);
});

test('effect 的值会做类型推断（true / 数字 / 字符串）', () => {
  assert.deepEqual(parseEffectSpec('flags.mood_warm set true').effect,
    { path: 'flags.mood_warm', op: 'set', value: true });
  assert.deepEqual(parseEffectSpec('actors.seeker.stats.trust add 3').effect,
    { path: 'actors.seeker.stats.trust', op: 'add', value: 3 });
  assert.deepEqual(parseEffectSpec('actors.seeker.emotion set 撑不住了').effect,
    { path: 'actors.seeker.emotion', op: 'set', value: '撑不住了' });
});

test('非法行逐条报出来，且带行号 —— 不静默吞', () => {
  const text = [
    '好的一行 | builtin | save',      // 1 ok
    '只有两段 | builtin',              // 2 三段缺失
    '类型不认识 | 乱写 | x',            // 3 kind 非法
    '运算不认识 | effect | a.b 加 1',   // 4 op 非法
    '路径没点 | effect | flags set 1', // 5 path 无点
    '内置不存在 | builtin | 飞升',      // 6 builtin 非法
    '重复标签 | builtin | undo',        // 7 ok
    '重复标签 | builtin | load',        // 8 标签重复
  ].join('\n');
  const { actions, issues } = parseActions(text);
  assert.equal(actions.length, 2, `应只接受 2 条，实收 ${actions.length}`);
  assert.equal(issues.length, 6, `应报 6 条问题，实报 ${issues.length}`);
  assert.deepEqual(issues.map(i => i.line), [2, 3, 4, 5, 6, 8]);
  for (const i of issues) assert.ok(i.why, '每条问题都要给原因');
});

test('effect 内容里允许出现竖线（只按前两段切）', () => {
  const { actions, issues } = parseActions('带竖线 | effect | actors.seeker.emotion set 走 | 停');
  assert.equal(issues.length, 0);
  // ⚠ 切段时各段已 trim，所以内容里的空格不会保留 —— 这是有意的，别把断言写成带空格的
  assert.equal(actions[0].effects[0].value, '走|停');
});

test('formatActions 能把动作还原成文本（存下来还能再读回去）', () => {
  const once = parseActions(DEFAULT_ACTIONS_TEXT).actions;
  const twice = parseActions(formatActions(once)).actions;
  assert.deepEqual(twice, once, '还原后再解析应与原动作一致');
});

test('内置动作清单与 UI 的映射对得上', () => {
  for (const k of ['save', 'load', 'undo', 'restart']) {
    assert.ok(BUILTIN_ACTIONS[k], `缺内置动作 ${k}`);
  }
});
