/**
 * 多版本（Swipe）—— 一轮生成几段，左右切换挑一段。
 *
 * 设计要点：
 *   1. **权威状态照旧。** 版本列表和当前选中项都存在 history 里，
 *      跟着存档走 —— 读档回来还能切。
 *   2. **第一段优先。** 先把第一段流式吐出来让玩家立刻读到，
 *      其余几段在后台补，补完切换条才亮起来。
 *   3. **切换不重算。** 只是换一段已生成的文本，不动任何数值。
 */

export const DEFAULT_VARIANT_COUNT = 1;
export const MAX_VARIANTS = 6;

function clampIndex(index, length) {
  if (!Number.isFinite(index) || length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, Math.trunc(index)));
}

/** 这条记录有哪些版本（老存档没有 variants 字段，用 text 兜底） */
export function variantsOf(record) {
  if (!record) return [];
  if (Array.isArray(record.variants) && record.variants.length > 0) {
    return record.variants.filter(t => typeof t === 'string' && t.trim());
  }
  return typeof record.text === 'string' && record.text.trim() ? [record.text] : [];
}

/** 当前选中的那一段 */
export function currentVariant(record) {
  const list = variantsOf(record);
  if (list.length === 0) return '';
  return list[clampIndex(record?.variantIndex ?? 0, list.length)];
}

/** 版本数与当前下标，给界面用 */
export function swipeState(record) {
  const list = variantsOf(record);
  const index = clampIndex(record?.variantIndex ?? 0, list.length);
  return {
    index,
    total: list.length,
    canPrev: index > 0,
    canNext: index < list.length - 1,
    canSwipe: list.length > 1,
  };
}

/** 追加一段新版本 */
export function addVariantEffects(turnIndex, text, { select = false } = {}) {
  const effects = [{ path: `history[${turnIndex}].variants`, op: 'push', value: text }];
  if (select) {
    // 选中项在 push 之后由调用方按实际长度算，这里不猜下标
    effects.push({ path: `history[${turnIndex}].text`, op: 'set', value: text });
  }
  return effects;
}

/**
 * 切到某一段。必须把 text 一起同步过去 ——
 * 界面与提示词读的都是 text，只改 variantIndex 会两边对不上。
 */
export function selectVariantEffects(turnIndex, index, text) {
  return [
    { path: `history[${turnIndex}].variantIndex`, op: 'set', value: index },
    { path: `history[${turnIndex}].text`, op: 'set', value: text },
  ];
}

/** 沿某个方向切换。到头就停住，不绕回（绕回会让人以为还能继续） */
export function stepVariant(record, direction) {
  const list = variantsOf(record);
  const current = clampIndex(record?.variantIndex ?? 0, list.length);
  const next = clampIndex(current + direction, list.length);
  return {
    index: next,
    text: list[next] ?? '',
    moved: next !== current,
  };
}
