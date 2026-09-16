import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoWorld, createDemoState } from '../data/demo.js';
import { nextTurn, applyTurn } from '../src/engine.js';
import { buildBuiltins, applyMacros, findUnknownMacros, applyMacrosToList } from '../src/macros.js';

/* ---------------------------------------------------------------- *
 * 内置量
 * ---------------------------------------------------------------- */

test('buildBuiltins 从状态里取常用量', () => {
  const world = createDemoWorld();
  const state = createDemoState();
  const b = buildBuiltins(state, world);

  assert.equal(b.day, '1');
  assert.equal(b.slot, '深夜');
  assert.equal(b.where, '你的房间');
  assert.equal(b.clues, '');
  assert.equal(b.actors, '');
});

test('已出场的角色才进 actors', () => {
  const world = createDemoWorld();
  const opened = nextTurn(createDemoState(), world);
  const { state: after } = applyTurn(opened.state, opened.event, 'A', world);

  const b = buildBuiltins(after, world);
  assert.match(b.actors, /老陈/);
  assert.ok(!b.actors.includes('苏黎'), '没见过的不该出现');
  assert.match(b.clues, /深夜的脚步声/);
});

test('缺 world 时不崩，退回原始值', () => {
  const state = createDemoState();
  const b = buildBuiltins(state, null);
  assert.equal(b.day, '1');
  assert.equal(b.slot, 'night');
  assert.equal(b.where, 'room');
});

test('buildBuiltins 能追加自定义量', () => {
  const b = buildBuiltins(createDemoState(), createDemoWorld(), { user: '赢容' });
  assert.equal(b.user, '赢容');
});

/* ---------------------------------------------------------------- *
 * 替换
 * ---------------------------------------------------------------- */

test('替换简单变量', () => {
  assert.equal(applyMacros('第 {{day}} 天', { builtins: { day: '3' } }), '第 3 天');
});

test('替换多个变量', () => {
  const out = applyMacros('{{a}}-{{b}}-{{a}}', { builtins: { a: '1', b: '2' } });
  assert.equal(out, '1-2-1');
});

test('自定义量优先于内置量', () => {
  const out = applyMacros('{{x}}', { vars: { x: '自定义' }, builtins: { x: '内置' } });
  assert.equal(out, '自定义');
});

test('认不出来的宏原样保留，不静默吃空', () => {
  assert.equal(applyMacros('{{没定义}}', {}), '{{没定义}}');
  assert.equal(applyMacros('前{{x}}后', {}), '前{{x}}后');
});

test('空文本与 null 安全', () => {
  assert.equal(applyMacros('', {}), '');
  assert.equal(applyMacros(null, {}), '');
  assert.equal(applyMacros(undefined, {}), '');
});

test('不碰非宏的花括号', () => {
  assert.equal(applyMacros('{不是宏}', {}), '{不是宏}');
  assert.equal(applyMacros('{}', {}), '{}');
});

/* ---------------------------------------------------------------- *
 * getvar / setvar
 * ---------------------------------------------------------------- */

test('getvar 读取自定义量', () => {
  assert.equal(applyMacros('{{getvar::心情}}', { vars: { 心情: '烦躁' } }), '烦躁');
});

test('setvar 写入并被后续 getvar 读到', () => {
  const vars = {};
  const out = applyMacros('{{setvar::阶段::二}}现在是{{getvar::阶段}}', { vars });
  assert.equal(out, '现在是二');
  assert.equal(vars.阶段, '二');
});

test('setvar 自身不产出可见文本', () => {
  assert.equal(applyMacros('A{{setvar::x::1}}B', { vars: {} }), 'AB');
});

test('setvar 的值里可以再含双冒号', () => {
  const vars = {};
  applyMacros('{{setvar::路径::a::b}}', { vars });
  assert.equal(vars.路径, 'a::b');
});

test('getvar 对不存在的名字保留原样', () => {
  assert.equal(applyMacros('{{getvar::无}}', { vars: {} }), '{{getvar::无}}');
});

test('setvar 缺名字时保留原样', () => {
  assert.equal(applyMacros('{{setvar::}}', { vars: {} }), '{{setvar::}}');
});

/* ---------------------------------------------------------------- *
 * 诊断
 * ---------------------------------------------------------------- */

test('findUnknownMacros 报出所有没定义的宏', () => {
  const unknown = findUnknownMacros('{{已知}} {{未知甲}} {{未知乙}}', { builtins: { 已知: 'x' } });
  assert.deepEqual(unknown, ['未知甲', '未知乙'], '按出现顺序返回，不排序');
});

test('findUnknownMacros 不把 setvar 当未知', () => {
  assert.deepEqual(findUnknownMacros('{{setvar::a::1}}', { vars: {} }), []);
});

test('findUnknownMacros 对全已知返回空', () => {
  assert.deepEqual(findUnknownMacros('{{a}}', { builtins: { a: '1' } }), []);
});

/* ---------------------------------------------------------------- *
 * 批量
 * ---------------------------------------------------------------- */

test('applyMacrosToList 共用同一份 vars', () => {
  const vars = {};
  const out = applyMacrosToList(['{{setvar::n::7}}', '{{getvar::n}}'], { vars });
  assert.deepEqual(out, ['', '7']);
});

/* ---------------------------------------------------------------- *
 * 与提示词结合
 * ---------------------------------------------------------------- */

test('角色卡式的 {{user}} / {{char}} 可以替换', () => {
  const out = applyMacros('{{user}} 看着 {{char}}，什么都没说。', {
    vars: { user: '你', char: '老陈' },
  });
  assert.equal(out, '你 看着 老陈，什么都没说。');
});

test('世界书条目内容可以统一过一遍宏', () => {
  const entries = [
    { id: 'W1', content: '第 {{day}} 天，{{char}} 在 {{where}}。' },
    { id: 'W2', content: '没有宏的一句。' },
  ];
  const builtins = buildBuiltins(createDemoState(), createDemoWorld());
  const rendered = entries.map(e => applyMacros(e.content, { vars: { char: '老陈' }, builtins }));

  assert.equal(rendered[0], '第 1 天，老陈 在 你的房间。');
  assert.equal(rendered[1], '没有宏的一句。');
});
