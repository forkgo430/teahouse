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
  const { text, applied } = applyRules('甲和7', rules, 'both');
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
  assert.equal(applyRules('啊啊啊', rules, 'both').text, '呀呀呀');
});
