/**
 * 上下文预算 / 提示词栈 / 正则后处理 —— 三个酒馆对位机制的单元测试。
 * 实现为自研轻量版（参考酒馆思路，未逐行复制其 AGPL 源码）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  trimHistory,
  buildSummary,
  budgetStatus,
} from '../src/context.js';
import { estimateTokens } from '../src/worldbook.js';
import {
  defaultStack,
  normalizePromptEntry,
  assembleStack,
  buildSystemMessage,
} from '../src/prompts.js';
import {
  createRegexChain,
  applyRules,
  applyOutbound,
  applyInbound,
  applyDisplayOutbound,
  applyDisplayInbound,
  SHIPPED_RULES,
  normalizeRule,
} from '../src/regex.js';

/* ---------------------------------------------------------------- *
 * 上下文预算
 * ---------------------------------------------------------------- */

function rec(text, extra = {}) {
  return { text, day: 1, eventId: 'E', branchKey: 'A', changes: [], ...extra };
}

test('预算内全部保留', () => {
  const h = [rec('第一轮'), rec('第二轮'), rec('第三轮')];
  const { kept, dropped, summary } = trimHistory(h, { budget: 5000, recentKeep: 2 });
  assert.equal(kept.length, 3);
  assert.equal(dropped.length, 0);
  assert.equal(summary, '');
});

test('超预算从最旧的开始丢', () => {
  const h = [
    rec('很旧的第一轮', { eventId: 'OLD' }),
    rec('较新的第二轮'),
    rec('最新第三轮'),
  ];
  const { kept, dropped } = trimHistory(h, { budget: 10, recentKeep: 1 });
  assert.ok(kept.length < 3);
  assert.equal(dropped[0].eventId, 'OLD', '最旧的先被丢');
});

test('最近 recentKeep 轮无条件保留', () => {
  const h = Array.from({ length: 8 }, (_, i) => rec(`第${i}轮内容`.repeat(20)));
  const { kept } = trimHistory(h, { budget: 1, recentKeep: 3 });
  assert.equal(kept.length, 3);
});

test('被裁轮次压成前情提要，含事件脉络', () => {
  const h = [
    rec('天色渐暗，雨还在下。', { eventId: 'R01', day: 1, said: '我来开门' }),
    rec('第二轮'),
    rec('第三轮'),
    rec('第四轮'),
  ];
  const { summary } = trimHistory(h, { budget: 1, recentKeep: 2 });
  assert.match(summary, /第1天/);
  assert.match(summary, /R01/);
  assert.match(summary, /我来开门/);
});

test('neverDropEventIds 永不丢弃', () => {
  const h = [rec('重要结局轮', { eventId: 'FINAL' }), rec('一'), rec('二')];
  const { kept } = trimHistory(h, { budget: 1, recentKeep: 1, neverDropEventIds: ['FINAL'] });
  assert.ok(kept.some(r => r.eventId === 'FINAL'));
});

test('预算状态给出占比', () => {
  const s = budgetStatus([rec('十'.repeat(50))], 100);
  assert.ok(s.tokens >= 50 && s.tokens <= 54, `join 换行算 2 字：实际 ${s.tokens}`);
  assert.equal(s.ratio, s.tokens / 100);
});

test('空历史不崩', () => {
  const { kept, summary } = trimHistory([], { budget: 100 });
  assert.equal(kept.length, 0);
  assert.equal(summary, '');
});

test('estimateTokens 中文按字算', () => {
  assert.equal(estimateTokens('一二三四五'), 5);
  assert.ok(estimateTokens('abc') >= 1);
});

/* ---------------------------------------------------------------- *
 * 提示词栈
 * ---------------------------------------------------------------- */

test('defaultStack 含引擎核心且锁定', () => {
  const stack = defaultStack('规则内容');
  assert.equal(stack.length, 1);
  assert.equal(stack[0].locked, true);
  assert.equal(stack[0].content, '规则内容');
});

test('assembleStack 按顺序拼启用的 system 条目', () => {
  const stack = [
    { id: 'a', role: 'system', content: '第一', enabled: true, order: 2 },
    { id: 'b', role: 'system', content: '第二', enabled: true, order: 1 },
    { id: 'c', role: 'system', content: '被禁用', enabled: false, order: 0 },
  ];
  const { system, injected } = assembleStack(stack);
  assert.equal(system, '第二\n\n第一');
  assert.equal(injected.length, 0);
});

test('非 system 条目进 injected', () => {
  const stack = [
    { id: 'u', role: 'user', content: '开场示例', enabled: true, order: 0 },
    { id: 's', role: 'system', content: '系统', enabled: true, order: 1 },
  ];
  const { system, injected } = assembleStack(stack);
  assert.equal(system, '系统');
  assert.deepEqual(injected, [{ role: 'user', content: '开场示例' }]);
});

test('buildSystemMessage 组合栈与引擎规则', () => {
  const stack = [
    { id: 'x', role: 'system', content: '用户规则', enabled: true, order: 0 },
  ];
  const msg = buildSystemMessage(stack, '引擎规则');
  assert.match(msg, /用户规则/);
  assert.match(msg, /引擎规则/);
});

test('normalizePromptEntry 兼容酒馆 prompts 字段', () => {
  const e = normalizePromptEntry({
    identifier: 'main', name: '主提示', role: 'system',
    content: '内容', enabled: false, injection_position: 0,
  }, 3);
  assert.equal(e.id, 'main');
  assert.equal(e.enabled, false);
});

test('空内容条目不进 system', () => {
  const { system } = assembleStack([
    { id: 'e', role: 'system', content: '   ', enabled: true, order: 0 },
  ]);
  assert.equal(system, '');
});

/* ---------------------------------------------------------------- *
 * 正则后处理
 * ---------------------------------------------------------------- */

test('createRegexChain 停用非法正则并报告', () => {
  const { rules, issues } = createRegexChain([
    { id: 'ok', find: '坏话', replace: '**', scope: 'out' },
    { id: 'bad', find: '[未闭合', replace: 'x', scope: 'out' },
  ]);
  assert.equal(rules.find(r => r.id === 'ok').enabled, true);
  const bad = rules.find(r => r.id === 'bad');
  assert.equal(bad.enabled, false);
  assert.equal(bad.invalid, true);
  assert.equal(issues.length, 1);
});

test('applyOutbound 替换模型输出', () => {
  const { rules } = createRegexChain([
    { id: 'r', find: '色色', replace: '**', scope: 'out' },
  ]);
  const { text } = applyOutbound('这里有色色内容', rules);
  assert.equal(text, '这里有**内容');
});

test('scope=in 的规则不影响输出', () => {
  const { rules } = createRegexChain([
    { id: 'r', find: '输入', replace: '输出', scope: 'in' },
  ]);
  const { text } = applyOutbound('输入文字', rules);
  assert.equal(text, '输入文字');
  const { text: tin } = applyInbound('输入文字', rules);
  assert.equal(tin, '输出文字');
});

test('替换保留捕获组（$1）', () => {
  const { rules } = createRegexChain([
    { id: 'r', find: '{{name}}', replace: '老陈', scope: 'out' },
  ]);
  assert.equal(applyOutbound('你好{{name}}', rules).text, '你好老陈');
});

test('运行时替换出错不中断链', () => {
  const { rules } = createRegexChain([
    { id: 'a', find: '甲', replace: '乙', scope: 'both' },
    { id: 'b', find: '(\\d)', replace: '[$1]', scope: 'both' },
  ]);
  const { text, applied } = applyRules('甲和7', rules, 'output', 'prompt');
  assert.equal(text, '乙和[7]');
  assert.deepEqual(applied, ['a', 'b']);
});

test('disabled 规则被跳过', () => {
  const { rules } = createRegexChain([
    { id: 'r', find: '机密', replace: '***', scope: 'out', enabled: false },
  ]);
  assert.equal(applyOutbound('机密内容', rules).text, '机密内容');
});

test('全局标志缺失时自动补 g（替换所有命中）', () => {
  const { rules } = createRegexChain([
    { id: 'r', find: '啊', replace: '呀', flags: '', scope: 'both' },
  ]);
  assert.equal(applyRules('啊啊啊', rules, 'output', 'prompt').text, '呀呀呀');
});

/* ---------------------------------------------------------------- *
 * destination 维度 —— source × destination 二维（读酒馆源码后确定）
 *
 * 社区教程把酒馆正则讲成"四个作用点选一"，读
 * JS-Slash-Runner/src/function/tavern_regex.ts 才知道是**两个正交维度**：
 *   source:      user_input | ai_output | …      这段文本从哪来
 *   destination: display | prompt                结果送去哪
 * 一条规则可同时挂两个 destination。
 * 「前端卡 token 安全」= 只开 display、不开 prompt。
 * ---------------------------------------------------------------- */

test('旧 scope 读时映射：out → 两个 destination 都开', () => {
  const { rules } = createRegexChain([{ id: 'r', find: 'x', replace: 'y', scope: 'out' }]);
  const r = rules[0];
  /* 旧规则当初就是同时影响存储与显示的，映射不能让它缩水 */
  assert.equal(r.source.output, true);
  assert.equal(r.source.input, false);
  assert.equal(r.destination.display, true);
  assert.equal(r.destination.prompt, true);
});

test('旧 scope 读时映射：in → 只开 input source', () => {
  const { rules } = createRegexChain([{ id: 'r', find: 'x', replace: 'y', scope: 'in' }]);
  assert.equal(rules[0].source.input, true);
  assert.equal(rules[0].source.output, false);
});

test('旧 scope 读时映射：both → 两个 source 都开', () => {
  const { rules } = createRegexChain([{ id: 'r', find: 'x', replace: 'y', scope: 'both' }]);
  assert.equal(rules[0].source.input, true);
  assert.equal(rules[0].source.output, true);
});

test('只开 display 的规则不改提示词 —— 这就是 token 安全的保证', () => {
  const { rules } = createRegexChain([{
    id: 'card', find: '<直播>(.+)</直播>', replace: '【直播：$1】',
    source: { output: true }, destination: { display: true, prompt: false },
  }]);

  // 送进提示词时：原样，模型看不到 HTML
  assert.equal(applyOutbound('开场<直播>打赏来了</直播>', rules).text,
               '开场<直播>打赏来了</直播>');

  // 显示给玩家时：被替换
  assert.equal(applyDisplayOutbound('开场<直播>打赏来了</直播>', rules).text,
               '开场【直播：打赏来了】');
});

test('只开 prompt 的规则不进显示层', () => {
  const { rules } = createRegexChain([{
    id: 'hide', find: '（隐藏提示）', replace: '',
    source: { output: true }, destination: { display: false, prompt: true },
  }]);
  assert.equal(applyOutbound('正文（隐藏提示）', rules).text, '正文');
  assert.equal(applyDisplayOutbound('正文（隐藏提示）', rules).text, '正文（隐藏提示）');
});

test('同一规则两个 destination 都开时，两条链路都生效', () => {
  const { rules } = createRegexChain([{
    id: 'both', find: '色色', replace: '**',
    source: { output: true }, destination: { display: true, prompt: true },
  }]);
  assert.equal(applyOutbound('有色色', rules).text, '有**');
  assert.equal(applyDisplayOutbound('有色色', rules).text, '有**');
});

test('source 不匹配时两个 destination 都不生效', () => {
  const { rules } = createRegexChain([{
    id: 'in-only', find: '甲', replace: '乙',
    source: { input: true }, destination: { display: true, prompt: true },
  }]);
  assert.equal(applyDisplayOutbound('甲', rules).text, '甲', '它是 input 规则，不该动 output');
  assert.equal(applyOutbound('甲', rules).text, '甲');
  assert.equal(applyInbound('甲', rules).text, '乙', 'input 链路该生效');
});

test('两个 destination 都不开的规则等于哑的（不报错也不改）', () => {
  const { rules } = createRegexChain([{
    id: 'dead', find: '甲', replace: '乙',
    source: { output: true }, destination: { display: false, prompt: false },
  }]);
  assert.equal(applyOutbound('甲', rules).text, '甲');
  assert.equal(applyDisplayOutbound('甲', rules).text, '甲');
});

/* ---------------------------------------------------------------- *
 * 出厂规则（SHIPPED_RULES）
 *
 * 为什么要有这几条：新装 localStorage 是空的，正则面板会是一片空白，
 * 玩家只看到一个「添加规则」按钮，不知道规则长什么样、能干什么。
 * ---------------------------------------------------------------- */

test('出厂规则每一条都能通过归一化且是合法的（不会一装上就报错）', () => {
  assert.ok(SHIPPED_RULES.length > 0, '出厂规则不能为空');
  for (const raw of SHIPPED_RULES) {
    const r = normalizeRule(raw);
    assert.equal(r.invalid, false, '出厂规则「' + raw.name + '」正则不合法');
    assert.equal(r.enabled, true, '出厂规则「' + raw.name + '」应当默认启用');
    assert.ok(
      r.destination.display || r.destination.prompt,
      '出厂规则「' + raw.name + '」两个 destination 都没开，等于哑的',
    );
    assert.ok(
      r.source.input || r.source.output,
      '出厂规则「' + raw.name + '」两个 source 都没开，永远不会被匹配到',
    );
  }
});

test('出厂规则要覆盖两个 destination —— 全都只开 display 就演示不了 token 安全', () => {
  const normalized = SHIPPED_RULES.map(r => normalizeRule(r));
  assert.ok(
    normalized.some(r => r.destination.display && !r.destination.prompt),
    '至少要有一条「只改显示、不进上下文」的，那才是前端卡的用法',
  );
  assert.ok(
    normalized.some(r => r.destination.prompt),
    '至少要有一条真的进提示词的，否则看不出这个维度存在',
  );
});

test('出厂规则的 id 不重复（重复会让删除按下时连带删掉别的）', () => {
  const ids = SHIPPED_RULES.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('出厂规则不会误伤不带标记的正文', () => {
  const { rules } = createRegexChain(SHIPPED_RULES);
  const plain = '你把伞收好，靠着门框没有动。';
  assert.equal(applyDisplayOutbound(plain, rules).text, plain, 'display 那几条不该动普通正文');
  assert.equal(applyOutbound(plain, rules).text, plain, 'prompt 那条只清行尾空白，也不该动它');
});

test('出厂规则的收尾空白条目：清掉行尾空格，且不改正文中间', () => {
  const { rules } = createRegexChain(SHIPPED_RULES);
  assert.equal(applyOutbound('雨停了三   ', rules).text, '雨停了三');
  assert.equal(applyOutbound('雨 停 了', rules).text, '雨 停 了', '中间的空格不是行尾，别动');
});

test('出厂规则里的展示规则确实能把心声标记变成 em —— 且只在显示层', () => {
  const { rules } = createRegexChain(SHIPPED_RULES);
  const src = '你听见 *他在门外站了很久*，没走。';
  const shown = applyDisplayOutbound(src, rules).text;
  assert.match(shown, /<em>他在门外站了很久<\/em>/, '显示层应当被渲染');
  assert.equal(
    applyOutbound(src, rules).text,
    src,
    '同一条规则只开 display，进提示词的文本必须原样 —— 这就是 token 安全',
  );
});
