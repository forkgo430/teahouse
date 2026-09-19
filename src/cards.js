/**
 * 一次性卡片技能 · 燕双鹰卡组（设定文档 §5.1）。
 *
 * 文档给的硬规则，逐条落到代码里：
 *   - 每张卡整局只能使用一次，用后**永久移除**；
 *   - 同一轮**最多使用一张**；
 *   - 不可被夺取或复制（所以这份牌只读、只减不增）；
 *   - **与成人内容无关**，不构成任何同意或边界豁免（§9.4）—— 因此绝不产生 consent/routes 效果；
 *   - 不改变固定债务真相与既有关系（所以不碰 flags.case_stage / 关系矩阵）。
 *
 * 和其它「可调用」的东西（§18 资源）分开写，是因为规则不同：
 * 资源有冷却、可反复用、有代价；卡是一次性的、无代价、整局限一张一轮。
 */

/** 记在哪：`flags.card_<id>_used` / `flags.card_last_turn`（同轮限一张） */
export function cardFlags(id) {
  return { used: `card_${id}_used`, lastTurn: 'card_last_turn' };
}

function numOr(state, path, fallback = null) {
  const v = state?.flags?.[path];
  return Number.isFinite(v) ? v : fallback;
}

/** 当前是第几轮（和引擎的 currentTurn 同口径）。 */
function turnOf(state) {
  return (state?.history?.length ?? 0) + 1;
}

/**
 * 能不能用这张卡。
 * @returns {{ok:boolean, reason?:string, def?:object, effects?:Array}}
 */
export function useCard(state, world, id) {
  const def = (world?.cards ?? []).find(c => c.id === id);
  if (!def) return { ok: false, reason: `没有这张卡：${id}` };

  const f = cardFlags(id);
  if (state?.flags?.[f.used] === true) {
    return { ok: false, reason: `「${def.name}」已经用过了 —— 一次性卡片，用后永久移除` };
  }

  const last = numOr(state, f.lastTurn);
  const turn = turnOf(state);
  if (last !== null && last === turn) {
    return { ok: false, reason: '同一轮最多用一张卡' };
  }

  // 文档：卡牌与成人内容无关，不豁免边界。这里把话写死在代码里，而不是靠注释。
  const effects = [
    { path: `flags.${f.used}`, op: 'set', value: true },
    { path: `flags.${f.lastTurn}`, op: 'set', value: turn },
  ];
  return { ok: true, def, effects };
}

/** 面板用：牌面 + 是否还在手里。 */
export function cardBoard(state, world) {
  return (world?.cards ?? []).map(def => {
    const f = cardFlags(def.id);
    const used = state?.flags?.[f.used] === true;
    const r = useCard(state, world, def.id);
    return {
      id: def.id,
      name: def.name,
      effect: def.effect ?? '',
      usage: def.usage ?? '',
      line: def.line ?? '',
      note: def.note ?? '',
      passive: def.passive === true,   // 「翻滚一闪 / 近战加成」是被动，不占卡位
      used,
      available: r.ok,
      reason: r.ok ? null : r.reason,
    };
  });
}

/** 还剩几张可主动使用的卡（被动卡不算）。 */
export function cardsLeft(state, world) {
  return cardBoard(state, world).filter(c => !c.passive && !c.used).length;
}
