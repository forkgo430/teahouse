/**
 * 编排层 —— 把「玩家输入 → 分支 → 叙事」串起来，并决定什么时候用模型、什么时候不用。
 *
 * 分工：
 *   · 本地规则解析（parser）先跑。命中就不用模型 —— 快、免费、离线可用。
 *   · 本地没命中，才让模型在**可用选项里做选择题**。模型不能自由发挥分支。
 *   · 叙事生成才用模型。拿不到就用预写文本，游戏不中断。
 *
 * 一句话：**模型是可选增强，不是必需依赖。** 关掉它游戏照样能通关。
 */

import { LLMError } from './llm.js';
import { interpretInput } from './engine.js';
import { scanWorldbook, renderWorldbook } from './worldbook.js';
import { applyMacros, buildBuiltins } from './macros.js';
import { trimHistory } from './context.js';
import { applyInbound, applyOutbound } from './regex.js';
import {
  buildChoiceMessages,
  buildNarrationMessages,
  describeSituation,
  extractChoice,
  cleanNarration,
} from './narrator.js';

export function createDirector({ world, client = null, onDelta = null, options = {} } = {}) {
  const hasModel = () => Boolean(client?.ready?.());

  const settings = {
    contextBudget: options.contextBudget ?? 6000,
    recentKeep: options.recentKeep ?? 4,
    inboundRules: options.inboundRules ?? [],
    outboundRules: options.outboundRules ?? [],
  };

  /**
   * 按当前局面扫世界书，只把命中的条目取出来。
   * 这一步是「按需注入」的关键：没被提到的设定根本不进上下文。
   */
  function loreFor(state, texts) {
    const book = world.book;
    if (!book || book.entries.length === 0) return '';

    const hit = scanWorldbook(book, {
      texts: texts.filter(t => typeof t === 'string' && t.trim()),
      state,
      budget: world.loreBudget ?? 1024,
    });
    if (hit.entries.length === 0) return '';

    const vars = {};
    const builtins = buildBuiltins(state, world);
    return renderWorldbook(hit.entries, t => applyMacros(t, { vars, builtins }));
  }

  /** 最近几轮的正文，世界书扫描要看它 */
  function recentTexts(state, n = 3) {
    return (state.history ?? []).slice(-n).map(r => r.text ?? '');
  }

  /**
   * 上下文装配：预算裁剪 + 前情提要 + 玩家输入预处理。
   * 返回 { texts, contextNote } —— texts 供世界书扫描，contextNote 供提示词。
   */
  function assembleContext(state, playerInput) {
    const inbound = playerInput && settings.inboundRules.length > 0
      ? applyInbound(playerInput, settings.inboundRules).text
      : playerInput;

    const { kept, dropped, summary } = trimHistory(state.history ?? [], {
      budget: settings.contextBudget,
      recentKeep: settings.recentKeep,
    });

    const texts = kept.map(r => r.text ?? '');
    const contextNote = summary ? `【前情提要（更早的剧情已折叠）】\n${summary}` : '';

    return { texts, contextNote, inbound, droppedCount: dropped.length };
  }

  /** 模型在可用选项里做选择题 */
  async function askModelForBranch(state, event, options, playerInput) {
    const usable = options.filter(o => o.available);
    const allowed = usable.map(o => o.key);
    if (allowed.length === 0) return null;

    const messages = buildChoiceMessages({
      brief: world.brief,
      situation: describeSituation(state, world),
      event,
      options,
      playerInput,
      lore: loreFor(state, [playerInput, ...recentTexts(state)]),
    });

    // 判断题不需要发散，温度压到 0
    const raw = await client.complete(messages, { temperature: 0, maxTokens: 200 });
    const choice = extractChoice(raw, allowed);

    return choice.branchKey
      ? { branchKey: choice.branchKey, reason: choice.reason, confidence: choice.confidence }
      : null;
  }

  return {
    hasModel,
    describe: () => (hasModel() ? client.describe() : { ready: false }),

    /**
     * 决定走哪个分支。
     * @returns {{ ok:boolean, branchKey:string|null, source:'local'|'auto'|'model'|'none', note?:string, error?:Error }}
     */
    async resolveBranch(state, event, options, playerInput) {
      const intent = interpretInput(state, event, playerInput);

      if (intent.kind === 'key') {
        return { ok: true, branchKey: intent.branchKey, source: 'local', intent };
      }
      if (intent.kind === 'auto') {
        return { ok: true, branchKey: null, source: 'auto', intent };
      }
      if (intent.kind === 'unavailable') {
        // 玩家说的事现在做不到 —— 让引擎去报「条件不成立」，别悄悄换一个
        return { ok: true, branchKey: intent.branchKey, source: 'local', intent };
      }

      // 本地没听懂，问问模型
      if (hasModel()) {
        try {
          const hit = await askModelForBranch(state, event, options, playerInput);
          if (hit) {
            return { ok: true, branchKey: hit.branchKey, source: 'model', note: hit.reason, intent };
          }
        } catch (e) {
          return { ok: false, branchKey: null, source: 'none', error: e, intent };
        }
      }

      return { ok: false, branchKey: null, source: 'none', intent };
    },

    /**
     * 生成本轮正文。模型不可用或出错时回落到预写文本。
     * @param {object} ctx
     * @param {boolean} [ctx.stream] 是否流式。补第二第三段时传 false，避免和第一段的增量抢同一个落点。
     * @returns {{ text:string, source:'model'|'scripted', lore?:string, error?:Error }}
     */
    async narrate({ state, event, branch, report, playerInput, stream = true }) {
      const scripted = branch.text ?? '';

      if (!hasModel()) return { text: scripted, source: 'scripted' };

      try {
        const ctx = assembleContext(state, playerInput);
        const lore = loreFor(state, [branch.label, playerInput ?? '', ...recentTexts(state)]);

        const messages = buildNarrationMessages({
          brief: world.brief,
          situation: describeSituation(state, world),
          event,
          branch,
          report,
          playerInput: ctx.inbound,
          world,
          lore: [lore, ctx.contextNote].filter(Boolean).join('\n\n'),
        });

        // 导入的预设若带系统提示词，拼在最前面（预设只影响"怎么说"，不改变则）
        if (world.presetSystemPrompt) {
          messages[0] = {
            role: 'system',
            content: `${world.presetSystemPrompt}\n\n${messages[0].content}`,
          };
        }

        const raw = (onDelta && stream)
          ? await client.stream(messages, { temperature: 0.9, maxTokens: 600 }, (_delta, full) => {
            const partial = cleanNarration(full);
            if (partial) onDelta(partial);
          })
          : await client.complete(messages, { temperature: 0.9, maxTokens: 600 });

        const cleaned = cleanNarration(raw);
        // 输出正则后处理（scope 'out' 的规则）
        const text = settings.outboundRules.length > 0
          ? applyOutbound(cleaned, settings.outboundRules).text
          : cleaned;
        if (!text) throw new LLMError('模型返回了空正文', { code: 'empty' });

        return { text, source: 'model', lore };
      } catch (e) {
        return { text: scripted, source: 'scripted', error: e };
      }
    },

    /** 给界面看：当前局面会用到哪些世界书条目 */
    lorePreview: (state, extra = []) => world.book
      ? scanWorldbook(world.book, { texts: [...extra, ...recentTexts(state)], state, budget: world.loreBudget ?? 1024 })
      : { entries: [], tokens: 0, dropped: [], fired: [] },
  };
}
