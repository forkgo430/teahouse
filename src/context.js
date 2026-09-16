/**
 * 上下文预算 —— 聊天历史按 token 预算裁剪，被裁掉的旧轮次自动压成「前情提要」。
 *
 * 酒馆的思路（预算内从旧到新丢弃 + 摘要兜底），实现是自研的轻量版：
 *   1. token 用启发式估算（中文 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token）
 *   2. 从最旧一轮开始丢弃整轮（不切半句），直到预算内
 *   3. 被丢弃的轮次压成一条「前情提要」放在最前 —— 信息有损但连续
 *   4. 结局/成就轮永不丢弃（那是故事的高光）
 */

import { estimateTokens } from './worldbook.js';

export const DEFAULT_CONTEXT_BUDGET = 6000;

/** 单条消息的 token 估算（正文 + 变化摘要 + 玩家原话） */
export function messageTokens(record) {
  const parts = [
    record.text ?? '',
    record.said ?? '',
    ...(record.changes ?? []).map(c => `${c.path}${c.op}${c.to ?? ''}`),
  ];
  return estimateTokens(parts.join('\n'));
}

/**
 * 按预算裁剪历史。
 * @param {object[]} history 引擎 history（新轮次 turn 更大）
 * @param {object} opts
 * @param {number} [opts.budget] 上下文 token 预算
 * @param {number} [opts.recentKeep] 无论预算如何都保留的最近轮数
 * @param {string[]} [opts.neverDropEventIds] 永不丢弃的事件 id（如终局事件）
 * @returns {{ kept: object[], dropped: object[], summary: string, tokens: number }}
 */
export function trimHistory(history, opts = {}) {
  const {
    budget = DEFAULT_CONTEXT_BUDGET,
    recentKeep = 4,
    neverDropEventIds = [],
  } = opts;

  const list = history ?? [];
  const protectedIds = new Set(neverDropEventIds);
  const kept = [];
  const dropped = [];
  let used = 0;

  // 从新到旧收集：最近 recentKeep 轮与受保护轮必留，其余按预算装
  for (let i = list.length - 1; i >= 0; i--) {
    const record = list[i];
    const cost = messageTokens(record);
    const isRecent = list.length - i <= recentKeep;
    const isProtected = protectedIds.has(record.eventId);

    if (isRecent || isProtected || used + cost <= budget) {
      kept.unshift(record);
      used += cost;
    } else {
      dropped.unshift(record);
    }
  }

  return {
    kept,
    dropped,
    summary: buildSummary(dropped),
    tokens: used,
  };
}

/** 被裁轮次压成前情提要：一行一轮（事件 · 分支），信息有损但脉络连续 */
export function buildSummary(dropped) {
  if (!dropped?.length) return '';
  return dropped
    .map(r => `第${r.day}天：${r.eventId ?? ''}${r.said ? `（你说：${r.said}）` : ''}${r.text ? ` —— ${firstSentence(r.text)}` : ''}`)
    .join('\n');
}

function firstSentence(text) {
  const s = String(text).replace(/\s+/g, '');
  const cut = s.search(/[。！？!?]/);
  return cut > 0 ? s.slice(0, cut + 1) : s.slice(0, 24);
}

/** 预算状态（给设置面板显示） */
export function budgetStatus(history, budget = DEFAULT_CONTEXT_BUDGET) {
  const total = (history ?? []).reduce((sum, r) => sum + messageTokens(r), 0);
  return { tokens: total, budget, ratio: budget > 0 ? total / budget : 0 };
}
