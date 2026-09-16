/**
 * 自由输入解析器 —— 把玩家的自然语言输入映射到「走哪个分支」。
 *
 * 设计约束：
 *   1. **不依赖模型**。纯规则，离线可用、可测试、同一输入永远同一结果。
 *   2. **匹配不上就说匹配不上**，不猜。猜错比说不知道更伤体验。
 *   3. **识别否定**。「我不想开门」不能匹配到「开门」。
 *
 * 匹配优先级（分数高者胜，同分取分支定义顺序）：
 *   分支显式声明的 keywords（权重 3）  >  分支 label（权重 2）
 *   分数 = 命中文本长度 × 权重 —— 越具体的说法越优先。
 */

/** 表示「随便你」的说法，命中则交给保底分支 */
export const AUTO_WORDS = Object.freeze([
  '随便', '都行', '你决定', '你来决定', '继续', '随意', '任意',
  '看着办', '无所谓', '都听你的', '你看着办', '都随你',
]);

/** 否定词：出现在匹配位置之前时，作废该次匹配 */
const NEGATION_TAIL_RE = /(不|别|没|无|勿|拒绝|不想|不要|不用|懒得)\s*$/;

const KEYWORD_WEIGHT = 3;
const LABEL_WEIGHT = 2;

/** 归一化：全角转半角、统一小写、压掉多余空白 */
export function normalizeText(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** 匹配位置之前 6 个字符内是否有否定词 */
function isNegated(norm, matchIndex) {
  const before = norm.slice(Math.max(0, matchIndex - 6), matchIndex);
  return NEGATION_TAIL_RE.test(before);
}

/**
 * 在事件的所有分支里找最匹配的一个。
 * @returns {{ branchKey: string, index: number, score: number, matched: string[] } | null}
 */
export function matchBranch(text, event) {
  const norm = normalizeText(text);
  if (!norm) return null;

  const branches = event?.branches ?? [];
  const hits = [];

  branches.forEach((branch, index) => {
    const candidates = [];
    for (const kw of branch.keywords ?? []) candidates.push({ raw: kw, weight: KEYWORD_WEIGHT });
    if (branch.label) candidates.push({ raw: branch.label, weight: LABEL_WEIGHT });

    let best = 0;
    const matched = [];

    for (const cand of candidates) {
      const target = normalizeText(cand.raw);
      if (!target) continue;

      const at = norm.indexOf(target);
      if (at < 0) continue;
      if (isNegated(norm, at)) continue;

      const score = target.length * cand.weight;
      if (score > best) best = score;
      matched.push(cand.raw);
    }

    if (best > 0) hits.push({ branchKey: branch.key, index, score: best, matched });
  });

  if (hits.length === 0) return null;

  hits.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return hits[0];
}

/** 是否是「随便你」这类放权说法 */
export function isAutoIntent(text) {
  const norm = normalizeText(text);
  if (!norm) return true;
  return AUTO_WORDS.some(w => norm.includes(normalizeText(w)));
}

/**
 * 解析入口
 * @returns {{ kind: 'auto'|'branch'|'unknown', branchKey?: string, score?: number, matched?: string[], reason?: string }}
 */
export function parseInput(text, event) {
  if (isAutoIntent(text)) {
    return { kind: 'auto', reason: '玩家把决定权交了出来' };
  }

  const hit = matchBranch(text, event);
  if (hit) {
    return {
      kind: 'branch',
      branchKey: hit.branchKey,
      score: hit.score,
      matched: hit.matched,
    };
  }

  return { kind: 'unknown', reason: '没有匹配到任何分支' };
}

/**
 * 给玩家的提示：当前有哪些可选项。
 * 用在「没听懂」的回执里，让玩家知道可以怎么说。
 */
export function suggestPhrases(event, availableKeys) {
  const keys = availableKeys ? new Set(availableKeys) : null;
  return (event?.branches ?? [])
    .filter(b => !keys || keys.has(b.key))
    .map(b => {
      const kw = (b.keywords ?? []).slice(0, 2);
      return kw.length > 0 ? `${b.label}（${kw.join('、')}）` : b.label;
    });
}
