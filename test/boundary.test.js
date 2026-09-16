import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState } from '../src/schema.js';
import { applyEffects } from '../src/state.js';
import { createWorld, applyTurn, TurnRejected } from '../src/engine.js';
import {
  CONSENT,
  CONSENT_STATES,
  ADVANCE_PERMITTING,
  NON_CONSENT_SOURCES,
  DEFAULT_SPEC,
  currentTurn,
  canAdvance,
  consentEffects,
  advanceEffects,
  withdrawEffects,
  renegotiateEffects,
  refuseEffects,
  trackAttemptEffects,
  isPestering,
  createConsentGuard,
  freezeEffects,
} from '../src/boundary.js';

/* ---------------------------------------------------------------- *
 * 夹具
 * ---------------------------------------------------------------- */

function baseState(over = {}) {
  const s = createInitialState({
    actors: [
      { id: 'a', name: '甲', stats: [{ key: 'trust', min: 0, max: 100, init: 50 }] },
      { id: 'minor', name: '未成年', adult: false, stats: [{ key: 'trust', min: 0, max: 100, init: 50 }] },
    ],
    clock: { day: 1, slot: 'night' },
    where: 'room',
  });
  return { ...s, ...over };
}

/** 造一个「刚刚在同一轮给出同意」的状态 */
function consented(route = 'open', value = CONSENT.ACCEPT) {
  const s = baseState({ routes: { a: route } });
  return applyEffects(s, consentEffects(s, 'a', value)).state;
}

/* ---------------------------------------------------------------- *
 * 常量
 * ---------------------------------------------------------------- */

test('五种意愿取值齐全', () => {
  assert.deepEqual(CONSENT_STATES, ['未公开表达', '接受', '拒绝', '撤回', '重新协商']);
  assert.deepEqual(ADVANCE_PERMITTING, ['接受', '重新协商']);
});

test('非同意来源被明确列举出来', () => {
  for (const item of ['经济帮助', '住宿', '债务援助', '隐藏打算', '内心想法', '身体状态描写', '路线未开启', '玩家单方面推定']) {
    assert.ok(NON_CONSENT_SOURCES.includes(item), `应包含「${item}」`);
  }
});

/* ---------------------------------------------------------------- *
 * canAdvance
 * ---------------------------------------------------------------- */

test('角色不存在时拒绝', () => {
  const r = canAdvance(baseState(), 'nobody');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unknown-actor');
});

test('未成年角色一律拒绝，与同意无关', () => {
  const s = baseState({ routes: { minor: 'open' } });
  const withConsent = applyEffects(s, consentEffects(s, 'minor', CONSENT.ACCEPT)).state;
  const r = canAdvance(withConsent, 'minor');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-adult');
});

test('路线未开启时拒绝', () => {
  const s = baseState();
  const withConsent = applyEffects(s, consentEffects(s, 'a', CONSENT.ACCEPT)).state;
  assert.equal(canAdvance(withConsent, 'a').code, 'route-closed');
});

test('路线冻结时拒绝并提示需重新协商', () => {
  const s = consented('frozen');
  const r = canAdvance(s, 'a');
  assert.equal(r.code, 'route-frozen');
  assert.match(r.reason, /重新协商/);
});

test('没有表达过意愿时拒绝', () => {
  const s = baseState({ routes: { a: 'open' } });
  const r = canAdvance(s, 'a');
  assert.equal(r.code, 'no-consent');
  assert.match(r.reason, /未公开表达/);
});

test('沉默与拒绝都不构成同意', () => {
  for (const value of [CONSENT.REFUSE, CONSENT.WITHDRAW, CONSENT.UNSPOKEN]) {
    const s = consented('open', value);
    assert.equal(canAdvance(s, 'a').ok, false, `${value} 不该放行`);
  }
});

test('接受与重新协商都放行', () => {
  for (const value of [CONSENT.ACCEPT, CONSENT.RENEGOTIATE]) {
    const s = consented('open', value);
    assert.equal(canAdvance(s, 'a').ok, true, `${value} 应放行`);
  }
});

test('同意只在当轮有效，下一轮自动失效', () => {
  const s = consented();
  assert.equal(canAdvance(s, 'a').ok, true, '当轮通过');

  // 推进一轮：history 变长，当前轮号变了
  const next = applyEffects(s, [{ path: 'history', op: 'push', value: { turn: 1 } }]).state;
  const r = canAdvance(next, 'a');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'consent-expired');
  assert.match(r.reason, /当轮有效/);
});

test('可以关掉「当轮有效」的检查', () => {
  const s = consented();
  const next = applyEffects(s, [{ path: 'history', op: 'push', value: { turn: 1 } }]).state;
  assert.equal(canAdvance(next, 'a', { requireCurrentTurn: false }).ok, true);
});

/* ---------------------------------------------------------------- *
 * 写入
 * ---------------------------------------------------------------- */

test('consentEffects 拒绝非法取值', () => {
  const s = baseState();
  assert.throws(() => consentEffects(s, 'a', '也许吧'), /未知的意愿取值/);
});

test('consentEffects 记录轮号，用于判定过期', () => {
  const s = baseState();
  const [eff] = consentEffects(s, 'a', CONSENT.ACCEPT);
  assert.equal(eff.value.turn, currentTurn(s));
  assert.equal(eff.value.state, '接受');
});

test('advanceEffects 在没同意时抛错且不改状态', () => {
  const s = baseState({ routes: { a: 'open' } });
  assert.throws(() => advanceEffects(s, 'a', 'advancing'), (e) => {
    assert.match(e.message, /边界拒绝/);
    assert.equal(e.code, 'no-consent');
    return true;
  });
});

test('advanceEffects 在同意成立时给出路线写入', () => {
  const s = consented();
  const effects = advanceEffects(s, 'a', 'advancing');
  const next = applyEffects(s, effects).state;
  assert.equal(next.routes.a, 'advancing');
});

/* ---------------------------------------------------------------- *
 * 撤回
 * ---------------------------------------------------------------- */

test('撤回冻结推进但不注销路线', () => {
  const s = consented('advancing');
  const next = applyEffects(s, withdrawEffects(s, 'a')).state;

  assert.equal(next.routes.a, 'frozen');
  assert.equal(next.consent.a.state, '撤回');
  assert.equal(next.flags.consent_withdrawn, true);
});

test('尊重撤回 → 信任上升', () => {
  const s = consented();
  const next = applyEffects(s, withdrawEffects(s, 'a', { respected: true })).state;
  assert.equal(next.actors.a.stats.trust, 50 + DEFAULT_SPEC.respectDelta);
});

test('纠缠着不放 → 信任下降', () => {
  const s = consented();
  const next = applyEffects(s, withdrawEffects(s, 'a', { respected: false })).state;
  assert.equal(next.actors.a.stats.trust, 50 + DEFAULT_SPEC.pesterDelta);
});

test('撤回后信任值仍被夹在边界内', () => {
  const s = consented();
  const low = applyEffects(s, [{ path: 'actors.a.stats.trust', op: 'set', value: 3 }]).state;
  const next = applyEffects(low, withdrawEffects(low, 'a', { respected: false })).state;
  assert.equal(next.actors.a.stats.trust, 0, '不该变成负数');
});

test('撤回后可以重新协商解冻', () => {
  const s = consented('advancing');
  const frozen = applyEffects(s, withdrawEffects(s, 'a')).state;
  assert.equal(canAdvance(frozen, 'a').ok, false);

  const reopened = applyEffects(frozen, renegotiateEffects(frozen, 'a', '只谈这栋楼的事')).state;
  assert.equal(reopened.routes.a, 'open');
  assert.equal(reopened.consent.a.state, '重新协商');
  assert.equal(reopened.consent.a.terms, '只谈这栋楼的事');
  assert.equal(canAdvance(reopened, 'a').ok, true, '解冻后当轮可推进');
});

/* ---------------------------------------------------------------- *
 * 拒绝与纠缠
 * ---------------------------------------------------------------- */

test('第一次拒绝不扣信任', () => {
  const s = baseState({ routes: { a: 'open' } });
  const { effects, pestering } = refuseEffects(s, 'a');
  assert.equal(pestering, false);
  const next = applyEffects(s, effects).state;
  assert.equal(next.consent.a.state, '拒绝');
  assert.equal(next.actors.a.stats.trust, 50);
});

test('冷静期内再拒绝算纠缠，信任下降', () => {
  const s = baseState({ routes: { a: 'open' } });
  const first = applyEffects(s, refuseEffects(s, 'a').effects).state;
  // 同一轮内再拒一次（轮号没变，仍在窗口内）
  const second = refuseEffects(first, 'a');
  assert.equal(second.pestering, true);
  const next = applyEffects(first, second.effects).state;
  assert.equal(next.actors.a.stats.trust, 50 + DEFAULT_SPEC.pesterDelta);
});

test('超出冷静期后不算纠缠', () => {
  let s = baseState({ routes: { a: 'open' } });
  s = applyEffects(s, refuseEffects(s, 'a').effects).state;
  // 推 5 轮
  for (let i = 0; i < 5; i++) {
    s = applyEffects(s, [{ path: 'history', op: 'push', value: { turn: i + 1 } }]).state;
  }
  assert.equal(isPestering(s, 'a'), false);
  assert.equal(refuseEffects(s, 'a').pestering, false);
});

test('isPestering 对没记录过的角色返回 false', () => {
  assert.equal(isPestering(baseState(), 'a'), false);
});

test('trackAttemptEffects 记录方向且保留上次拒绝时间', () => {
  const s = baseState({ routes: { a: 'open' } });
  const refused = applyEffects(s, refuseEffects(s, 'a').effects).state;
  const tracked = applyEffects(refused, trackAttemptEffects(refused, 'a', '靠近')).state;
  assert.equal(tracked.tracks.a.direction, '靠近');
  assert.equal(tracked.tracks.a.lastRefusedTurn, 0, '不该抹掉拒绝记录');
});

/* ---------------------------------------------------------------- *
 * 作为 guard 接入引擎
 * ---------------------------------------------------------------- */

function worldWith(gated) {
  return createWorld({
    events: [{
      id: 'E1',
      title: '试探',
      require: null,
      fallback: 'A',
      branches: [
        { key: 'A', label: '普通的说话', cond: null, text: '普通', effects: [] },
        {
          key: 'B',
          label: '靠近一步',
          cond: null,
          text: '靠近',
          requiresConsent: 'a',
          effects: [{ path: 'flags.stepped', op: 'set', value: true }],
        },
        ...(gated ? [] : []),
      ],
    }],
    guards: [createConsentGuard()],
  });
}

test('guard 拦下未获同意的推进，状态原封不动', () => {
  const world = worldWith();
  const s = baseState({ routes: { a: 'open' } });
  const before = JSON.stringify(s);

  assert.throws(() => applyTurn(s, world.events[0], 'B', world), (e) => {
    assert.ok(e instanceof TurnRejected);
    assert.match(e.message, /边界/);
    return true;
  });
  assert.equal(JSON.stringify(s), before);
});

test('拿到当轮同意后可以推进', () => {
  const world = worldWith();
  const s = consented();
  const { state: next, report } = applyTurn(s, world.events[0], 'B', world);
  assert.equal(report.branchKey, 'B');
  assert.equal(next.flags.stepped, true);
  assert.equal(next.actors.a.stats.trust, 50, '纯推进不自动改数值');
});

test('没有 requiresConsent 的分支不受影响', () => {
  const world = worldWith();
  const s = baseState({ routes: { a: 'open' } });
  const { state: next } = applyTurn(s, world.events[0], 'A', world);
  assert.equal(next.history.length, 1);
});

test('freezeEffects 冻结路线并扣信任', () => {
  const s = consented('advancing');
  const next = applyEffects(s, freezeEffects(s, 'a')).state;
  assert.equal(next.routes.a, 'frozen');
  assert.equal(next.actors.a.stats.trust, 50 + DEFAULT_SPEC.pesterDelta);
});
