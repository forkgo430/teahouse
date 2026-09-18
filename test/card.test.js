/**
 * 结构化正文渲染 —— 解析层测试。
 *
 * 渲染层（DOM）由冒烟覆盖；这里测**纯函数**的解析边界。
 * 核心纪律：**不认识的东西原样保留，绝不吞玩家的字**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCardMarkup,
  parseInline,
  hasCardMarkup,
} from '../src/card.js';

/* ---------------------------------------------------------------- *
 * 区块解析
 * ---------------------------------------------------------------- */

test('解析一个完整的 [状态栏] 区块', () => {
  const segs = parseCardMarkup('前面的话\n[状态栏]\n好感度 = 72\n疲惫 = 31\n[/状态栏]\n后面的话');
  assert.equal(segs.length, 3);
  assert.equal(segs[0].type, 'text');
  assert.equal(segs[0].text, '前面的话');
  assert.equal(segs[1].type, 'block');
  assert.equal(segs[1].kind, 'stats');
  assert.equal(segs[1].title, '状态栏');
  assert.deepEqual(segs[1].items, [
    { key: '好感度', value: '72' },
    { key: '疲惫', value: '31' },
  ]);
  assert.equal(segs[2].text, '后面的话');
});

test('全角等号与空格都认', () => {
  const segs = parseCardMarkup('[状态栏]\n好感度＝72\n疲惫 ＝ 31\n[/状态栏]');
  assert.deepEqual(segs[0].items, [
    { key: '好感度', value: '72' },
    { key: '疲惫', value: '31' },
  ]);
});

test('[物品栏] 走 list 组件', () => {
  const segs = parseCardMarkup('[物品栏]\n旧钥匙\n半张照片\n[/物品栏]');
  assert.equal(segs[0].kind, 'list');
  assert.deepEqual(segs[0].items, [
    { key: null, value: '旧钥匙' },
    { key: null, value: '半张照片' },
  ]);
});

test('流没闭合也不吞内容（宁可多显示）', () => {
  const segs = parseCardMarkup('[状态栏]\n好感度 = 72');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'block');
  assert.equal(segs[0].items.length, 1, '未闭合也要把已读到的项留下');
});

test('不认识的名字当普通文本，不做渲染', () => {
  /* 「[注意]」不在组件集里 —— 必须原样留在正文，不能被吃掉 */
  const segs = parseCardMarkup('[注意]\n这里有陷阱\n[/注意]');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'text');
  assert.match(segs[0].text, /\[注意\]/);
  assert.match(segs[0].text, /这里有陷阱/);
});

test('行内出现的方括号不算区块开始', () => {
  /* 「他说[明天]见」里的 [明天] 不在行首，且不在组件集里 */
  const segs = parseCardMarkup('他说[明天]见。');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'text');
});

test('组件集里的名字在行内也不当区块（必须独占一行）', () => {
  const segs = parseCardMarkup('他提到了[状态栏]这个词');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'text', '不独占一行就不该开区块');
});

test('空文本返回空数组', () => {
  assert.deepEqual(parseCardMarkup(''), []);
  assert.deepEqual(parseCardMarkup('   \n  '), []);
});

test('纯正文不受影响（没有标记时只有一段 text）', () => {
  const segs = parseCardMarkup('雨还在下。\n他把伞递了过来。');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, 'text');
});

test('两个区块连着出现', () => {
  const segs = parseCardMarkup('[状态栏]\n好感 = 1\n[/状态栏]\n[物品栏]\n钥匙\n[/物品栏]');
  assert.equal(segs.length, 2);
  assert.equal(segs[0].kind, 'stats');
  assert.equal(segs[1].kind, 'list');
});

/* ---------------------------------------------------------------- *
 * 行内标记
 * ---------------------------------------------------------------- */

test('行内 [签:…] 解析成标签', () => {
  const parts = parseInline('他有点[签:紧张]地看着你');
  assert.deepEqual(parts, [
    { type: 'text', text: '他有点' },
    { type: 'tag', text: '紧张' },
    { type: 'text', text: '地看着你' },
  ]);
});

test('行内 [条:键|当前|上限] 解析成进度条', () => {
  const parts = parseInline('[条:好感度|72|100]');
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], { type: 'bar', key: '好感度', value: 72, max: 100 });
});

test('不认识的行内前缀原样保留 —— 绝不吞字', () => {
  const parts = parseInline('看这个[链接:http://x]和这个[注:说明]');
  const joined = parts.map(p => (p.type === 'text' ? p.text : `[${p.type}]`)).join('');
  assert.match(joined, /\[链接:http:\/\/x\]/);
  assert.match(joined, /\[注:说明\]/);
});

test('纯文本走 parseInline 只出一段', () => {
  const parts = parseInline('没有标记的一句话');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[0].text, '没有标记的一句话');
});

/* ---------------------------------------------------------------- *
 * 快速判定
 * ---------------------------------------------------------------- */

test('hasCardMarkup 只认组件集里的区块', () => {
  assert.equal(hasCardMarkup('[状态栏]\n好感 = 1\n[/状态栏]'), true);
  assert.equal(hasCardMarkup('[物品栏]\n钥匙\n[/物品栏]'), true);
  assert.equal(hasCardMarkup('[注意]\n陷阱\n[/注意]'), false, '不在组件集里');
  assert.equal(hasCardMarkup('普通正文，没有标记'), false);
  assert.equal(hasCardMarkup('他说[状态栏]这个词'), false, '不独占一行');
});

test('hasCardMarkup 认行内标记，且不残留 lastIndex 状态', () => {
  assert.equal(hasCardMarkup('有点[签:紧张]'), true);
  /* 连续调用两次结果必须一致 —— 带 g 的正则 lastIndex 会残留 */
  assert.equal(hasCardMarkup('有点[签:紧张]'), true);
  assert.equal(hasCardMarkup('没有标记'), false);
  assert.equal(hasCardMarkup('有点[签:紧张]'), true);
});
