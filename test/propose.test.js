import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractProposals, validateProposals, PROPOSE_LIMIT, PROPOSE_MAX_DELTA,
} from '../src/propose.js';

/* 「模型可提 effects」是唯一动到「谁能改状态」的一档，所以这里测的不是
   "能不能用"，而是**骨架有没有被挡住** —— 白名单、上限、不静默。 */

test('解析：把【状态变更】块从正文里摘出来，玩家看不到 JSON', () => {
  const text = '她接过钥匙，收进内袋。\n\n【状态变更】\n'
    + '[{"path":"actors.seeker.emotion","op":"set","value":"撑不住了"}]\n【/状态变更】';
  const got = extractProposals(text);
  assert.equal(got.clean, '她接过钥匙，收进内袋。', `摘完还剩：${got.clean}`);
  assert.equal(got.list.length, 1);
  assert.equal(got.list[0].path, 'actors.seeker.emotion');
});

test('解析：没有块 / JSON 写坏，都当"没提"，不抛不阻断', () => {
  assert.deepEqual(extractProposals('就一句普通正文').list, null);
  const bad = extractProposals('正文\n【状态变更】\n这不是 JSON\n【/状态变更】');
  assert.equal(bad.list, null, '坏 JSON 应当是 null');
  assert.ok(bad.clean.includes('正文'), '坏 JSON 也不该吞掉正文');
});

test('校验：描写字段可以 set，数值可以小幅增减', () => {
  const v = validateProposals([
    { path: 'actors.seeker.emotion', op: 'set', value: '撑不住了' },
    { path: 'actors.seeker.stats.trust', op: 'add', value: 3 },
    { path: 'ledger.expense', op: 'add', value: 500 },
  ]);
  assert.equal(v.accepted.length, 3, JSON.stringify(v.rejected));
  assert.equal(v.rejected.length, 0);
});

test('校验：骨架一律挡下（线索/阶段/路线/同意/结局/成就/历史/时钟）', () => {
  const v = validateProposals([
    { path: 'clues', op: 'push', value: 'S9' },
    { path: 'flags.case_stage', op: 'add', value: 1 },
    { path: 'routes.seeker', op: 'set', value: 'settled' },
    { path: 'consent.seeker', op: 'set', value: { state: 'agreed' } },
    { path: 'endings', op: 'push', value: 'END_A1' },
    { path: 'achievements', op: 'push', value: 'A_R01' },
    { path: 'history', op: 'push', value: {} },
    { path: 'clock.day', op: 'set', value: 200 },
    { path: 'actors.seeker.intimacy.count', op: 'add', value: 1 },
  ]);
  assert.equal(v.accepted.length, 0, `居然放过了：${JSON.stringify(v.accepted)}`);
  assert.equal(v.rejected.length, 9);
  for (const r of v.rejected) assert.ok(r.why, '被挡下的必须给出原因（不静默）');
});

test('校验：单轮条数、单轮幅度、非白名单路径都有上限', () => {
  const many = Array.from({ length: PROPOSE_LIMIT + 2 }, () => (
    { path: 'actors.seeker.stats.trust', op: 'add', value: 1 }
  ));
  const v1 = validateProposals(many);
  assert.equal(v1.accepted.length, PROPOSE_LIMIT, '没按上限截断');
  assert.ok(v1.rejected.some(r => /上限/.test(r.why)));

  const big = validateProposals([{ path: 'actors.seeker.stats.trust', op: 'add', value: PROPOSE_MAX_DELTA + 1 }]);
  assert.equal(big.accepted.length, 0, '超过单轮幅度还被放行');
  assert.match(big.rejected[0].why, /幅度/);

  const out = validateProposals([{ path: 'flags.path_seeker', op: 'set', value: '伴侣' }]);
  assert.equal(out.accepted.length, 0, '路线类的 flag 不该被放行');

  const setNum = validateProposals([{ path: 'actors.seeker.stats.trust', op: 'set', value: 99 }]);
  assert.equal(setNum.accepted.length, 0, '数值只准 add/sub，set 绝对值会写飞');
});

test('校验：wide 档放开阶段与路线，但不放开结局与线索', () => {
  const wide = validateProposals([
    { path: 'flags.case_stage', op: 'add', value: 1 },
    { path: 'routes.seeker', op: 'set', value: 'advancing' },
    { path: 'clues', op: 'push', value: 'S9' },
    { path: 'endings', op: 'push', value: 'END_A1' },
  ], { tier: 'wide' });
  assert.equal(wide.accepted.length, 2, JSON.stringify(wide.accepted));
  assert.ok(wide.accepted.some(e => e.path === 'flags.case_stage'));
  assert.ok(wide.accepted.some(e => e.path === 'routes.seeker'));
  assert.ok(wide.rejected.some(r => /clues/.test(String(r.effect?.path))), '线索在宽档也该挡');
  assert.ok(wide.rejected.some(r => /endings/.test(String(r.effect?.path))), '结局在任何档都该挡');
});
