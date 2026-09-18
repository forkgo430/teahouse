/**
 * 同意与边界系统 —— 把「推进需要对方同意」做成引擎强制的规则，不靠提示词自觉。
 *
 * 这是通用机制，不是某题材专属：任何「关系推进必须获得对方当轮明确同意」的叙事都用得上。
 *
 * 规则（形式化）：
 *   同意 = 成年 ∧ 清醒 ∧ 自愿 ∧ 可撤回 ∧ 可重新协商 ∧ **当轮公开表达**
 *
 *   以下都不构成同意：
 *     经济帮助 / 住宿 / 债务援助 / 隐藏打算 / 内心想法 / 身体状态描写 /
 *     路线未开启 / 玩家单方面推定 / 沉默 / 未回应
 *
 *   推进条件：
 *     路线 ∈ {已开启, 推进中} ∧ 当轮意愿 ∈ {接受, 重新协商} ∧ 角色成年
 *
 *   撤回：
 *     立即停；不追问理由；不冷暴力；关系回退；路线冻结但**不注销**；
 *     尊重撤回 → 信任 +5；反复纠缠 → 信任 −15
 *
 * 关键点：同意**只在当轮有效**。上一轮说过「接受」，这一轮要重新确认。
 */

import { applyEffects } from './state.js';

export const CONSENT = Object.freeze({
  UNSPOKEN: '未公开表达',
  ACCEPT: '接受',
  REFUSE: '拒绝',
  WITHDRAW: '撤回',
  RENEGOTIATE: '重新协商',
});

export const CONSENT_STATES = Object.freeze(Object.values(CONSENT));

/** 允许推进的意愿 */
export const ADVANCE_PERMITTING = Object.freeze([CONSENT.ACCEPT, CONSENT.RENEGOTIATE]);

/** 明确列举：这些事发生了，也**不等于**同意 */
export const NON_CONSENT_SOURCES = Object.freeze([
  '经济帮助', '住宿', '债务援助', '隐藏打算', '内心想法', '身体状态描写',
  '路线未开启', '玩家单方面推定', '沉默', '未回应',
]);

export const DEFAULT_SPEC = Object.freeze({
  trustStat: 'trust',
  respectDelta: 5,
  pesterDelta: -15,
  pesterWindow: 3,
  requireCurrentTurn: true,
});

/**
 * 当前轮号 —— **正在进行的这一轮**，从 1 起算。
 *
 * 为什么不是 `history.length`：effects 在 recordHistory **之前**执行，
 * 所以把「表态」动作写进 effects 时，`history.length` 还是上一轮的数。
 * 若按 history.length 记轮号，表态这一轮记的是 T、下一轮 guard 看到的是 T+1，
 * 永远对不上，闸门等于永远锁死。
 * 统一成「正在进行/即将进行的那一轮」，两种写入时机（轮内 effects、两轮之间登记）
 * 落在同一个数上，语义才自洽。
 */
export function currentTurn(state) {
  return (state.history ?? []).length + 1;
}

function hasStat(state, actorId, key) {
  return Boolean(state.actors?.[actorId]?.bounds?.[key]);
}

function consentRecord(state, actorId) {
  return state.consent?.[actorId] ?? null;
}

/**
 * 能不能推进。这是唯一的判据 —— 其它地方不许自己判断。
 * @returns {{ ok: boolean, code: string, reason?: string }}
 */
export function canAdvance(state, actorId, spec = {}) {
  const s = { ...DEFAULT_SPEC, ...spec };

  const actor = state.actors?.[actorId];
  if (!actor) return { ok: false, code: 'unknown-actor', reason: `角色 ${actorId} 不存在` };
  if (actor.adult === false) {
    return { ok: false, code: 'not-adult', reason: `角色 ${actorId} 未标记为成年，一律不推进` };
  }

  const route = state.routes?.[actorId] ?? 'closed';
  if (route === 'closed') return { ok: false, code: 'route-closed', reason: '路线未开启' };
  if (route === 'frozen') {
    return { ok: false, code: 'route-frozen', reason: '路线已因撤回冻结，需先重新协商' };
  }

  const record = consentRecord(state, actorId);
  const value = record?.state ?? CONSENT.UNSPOKEN;

  if (!ADVANCE_PERMITTING.includes(value)) {
    return { ok: false, code: 'no-consent', reason: `当轮意愿为「${value}」，不构成同意` };
  }

  if (s.requireCurrentTurn) {
    const turn = currentTurn(state);
    if (record?.turn !== turn) {
      return { ok: false, code: 'consent-expired', reason: '同意只在当轮有效，需重新确认' };
    }
  }

  return { ok: true, code: 'ok' };
}

/* ------------------------------------------------------------------ *
 * 状态写入
 * ------------------------------------------------------------------ */

/** 记录当轮意愿 */
export function consentEffects(state, actorId, value, { terms = null, turn = null } = {}) {
  if (!CONSENT_STATES.includes(value)) {
    throw new Error(`未知的意愿取值：${JSON.stringify(value)}，允许 ${CONSENT_STATES.join(' / ')}`);
  }
  return [{
    path: `consent.${actorId}`,
    op: 'set',
    value: { state: value, terms, turn: turn ?? currentTurn(state) },
  }];
}

/** 开启或推进路线（前提是同意成立） */
export function advanceEffects(state, actorId, nextRoute, spec = {}) {
  const s = { ...DEFAULT_SPEC, ...spec };
  const gate = canAdvance(state, actorId, s);
  if (!gate.ok) {
    const err = new Error(`推进被边界拒绝：${gate.reason}`);
    err.code = gate.code;
    throw err;
  }
  return [{ path: `routes.${actorId}`, op: 'set', value: nextRoute }];
}

/**
 * 撤回。已经建立的路线只是冻结，不注销。
 * @param {object} state
 * @param {string} actorId
 * @param {{ respected?: boolean, spec?: object }} [options] respected=false 表示玩家纠缠
 */
export function withdrawEffects(state, actorId, options = {}) {
  const s = { ...DEFAULT_SPEC, ...options.spec };
  const respected = options.respected !== false;
  const turn = currentTurn(state);

  const effects = [
    { path: `consent.${actorId}`, op: 'set', value: { state: CONSENT.WITHDRAW, terms: null, turn } },
    // 冻结推进，但不注销：路线状态停在 frozen，重新协商后可解冻
    { path: `routes.${actorId}`, op: 'set', value: 'frozen' },
    { path: 'flags.consent_withdrawn', op: 'set', value: true },
    /* 撤回次数。A_H07「三缄其口」的 cond 写死了这个路径，所以计数必须落在
       flags.withdraw_count 上（不是 $auto —— 那是给没有可派生源的观测值用的，
       而这里数据层已经指定了路径，改路径等于改判定）。

       累加放在**这里**而不是调用方：放在 UI 就变成"每个调用点都记得加"，
       漏一处 A_H07 就永远解锁不了，而且不报错。累加点必须唯一。 */
    { path: 'flags.withdraw_count', op: 'add', value: 1 },
  ];

  if (hasStat(state, actorId, s.trustStat)) {
    effects.push({
      path: `actors.${actorId}.stats.${s.trustStat}`,
      op: 'add',
      value: respected ? s.respectDelta : s.pesterDelta,
    });
  }
  return effects;
}

/** 重新协商：解冻，并把这一轮可以什么写进当轮意愿 */
export function renegotiateEffects(state, actorId, terms = null, spec = {}) {
  return [
    { path: `consent.${actorId}`, op: 'set', value: { state: CONSENT.RENEGOTIATE, terms, turn: currentTurn(state) } },
    { path: `routes.${actorId}`, op: 'set', value: 'open' },
  ];
}

/** 拒绝：记录轨迹，用于判定后续是否纠缠 */
export function refuseEffects(state, actorId, spec = {}) {
  const s = { ...DEFAULT_SPEC, ...spec };
  const turn = currentTurn(state);
  const previous = state.tracks?.[actorId];
  const pestering = previous?.lastRefusedTurn !== undefined
    && (turn - previous.lastRefusedTurn) < s.pesterWindow;

  const effects = [
    { path: `consent.${actorId}`, op: 'set', value: { state: CONSENT.REFUSE, terms: null, turn } },
    {
      path: `tracks.${actorId}`,
      op: 'set',
      value: { direction: previous?.direction ?? null, turn, lastRefusedTurn: turn },
    },
  ];

  if (pestering && hasStat(state, actorId, s.trustStat)) {
    effects.push({
      path: `actors.${actorId}.stats.${s.trustStat}`,
      op: 'add',
      value: s.pesterDelta,
    });
  }

  return { effects, pestering };
}

/** 记录一次试探方向，用于「同一方向不得反复试探」 */
export function trackAttemptEffects(state, actorId, direction) {
  const previous = state.tracks?.[actorId] ?? {};
  return [{
    path: `tracks.${actorId}`,
    op: 'set',
    value: { ...previous, direction, turn: currentTurn(state) },
  }];
}

/** 同一方向是否处在冷静期内 */
export function isPestering(state, actorId, spec = {}) {
  const s = { ...DEFAULT_SPEC, ...spec };
  const track = state.tracks?.[actorId];
  if (!track || track.lastRefusedTurn === undefined) return false;
  return (currentTurn(state) - track.lastRefusedTurn) < s.pesterWindow;
}

/* ------------------------------------------------------------------ *
 * 作为引擎 guard 接入
 * ------------------------------------------------------------------ */

/**
 * 把边界变成引擎强制的 guard：
 * 分支上写 `requiresConsent: '角色id'`，不满足就整轮被拒，状态原封不动。
 */
export function createConsentGuard(options = {}) {
  const spec = { ...DEFAULT_SPEC, ...options };
  return ({ state, branch }) => {
    const actorId = branch?.requiresConsent;
    if (!actorId) return { ok: true };
    const gate = canAdvance(state, actorId, spec);
    return gate.ok ? { ok: true } : { ok: false, reason: `边界：${gate.reason}`, code: gate.code };
  };
}

/** 把整个角色的路线冻结掉（比如玩家严重越界） */
export function freezeEffects(state, actorId) {
  const effects = [{ path: `routes.${actorId}`, op: 'set', value: 'frozen' }];
  if (hasStat(state, actorId, DEFAULT_SPEC.trustStat)) {
    effects.push({ path: `actors.${actorId}.stats.${DEFAULT_SPEC.trustStat}`, op: 'add', value: DEFAULT_SPEC.pesterDelta });
  }
  return effects;
}
