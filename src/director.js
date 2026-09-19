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
import { assembleStack } from './prompts.js';
import { buildFreeMessages, parseSegments, segmentsToText, pickSpeakers } from './freechat.js';
import {
  buildChoiceMessages,
  buildNarrationMessages,
  describeSituation,
  extractChoice,
  cleanNarration,
  labelForPath,
  resolveValue,
} from './narrator.js';
import { makeStatusCard } from './card.js';
import { matchTriggers, triggerNote } from './trigger.js';

/**
 * 叙述类请求（narrate / freeReply）的 token 上限，跟随文风档位。
 *
 * 旧版把 maxTokens 写死成 600/700，按「中文字 ≈ 1.3~1.6 token」算，只能撑到
 * 450 字上下 —— 一旦选「舒展 / 长叙 / 分段」就被天花板截断，且不报错，只写不长。
 * 这是本项目最常踩的静默降级，所以上限不再写死，而是按档位给足余量。
 *
 * 字母档是「选择题」（resolveIntent / extractChoice），判个分支键而已，温度压到 0，
 * 200 足够，不在此列。
 */
const LENGTH_MAX_TOKENS = {
  short: 700,        // 220~360 字
  normal: 1100,      // 450~620 字
  long: 1700,        // 800~1000 字
  longer: 4000,      // 1200~2400 字
  segmented: 4000,   // 不限·逐事件写完
  unlimited: 4000,   // 不限
};
function maxTokensForLength(length) {
  return LENGTH_MAX_TOKENS[length] ?? 4000;
}

export function createDirector({ world, client = null, onDelta = null, options = {} } = {}) {
  const hasModel = () => Boolean(client?.ready?.());

  const settings = {
    contextBudget: options.contextBudget ?? 6000,
    recentKeep: options.recentKeep ?? 4,
    inboundRules: options.inboundRules ?? [],
    outboundRules: options.outboundRules ?? [],
    promptStack: options.promptStack ?? [],
    narrationStyle: options.narrationStyle ?? null,
    /* 状态卡：由**引擎**按本轮变化算出卡片标记，交模型原样带回正文。
       关掉它模型就继续自由发挥（老行为）。 */
    statusCard: options.statusCard ?? true,
    /* 雨夜机制开关的读法，由 UI 递进来。
       director 与 engine 一样**不读 localStorage** —— 读法从上面传，方便测。 */
    mech: options.mech ?? (() => true),
    /* buildView 由调用方注入 —— director 不 import engine.js（engine 反过来
       不依赖 director，保持单向）。inject 的写法也让 test 里能塞个 stub。 */
    buildView: options.buildView ?? null,
  };

  /**
   * 本轮卡片标记。
   *
   * 关键点：**内容是引擎算的，模型只负责搬运。** 卡片一定出现、字段一定
   * 与数值对得上，而不是"求模型自发输出结构化值"。
   *
   * 标 `✓` 的字段是引擎真值；模型若自己在卡片里加了几行（比如临时编一个
   * 「天气 = 转冷」），那些行没有标记，玩家一眼能分出来。
   */
  function statusCardFor(state, report) {
    if (!settings.statusCard) return '';
    /* 雨夜模式的卡片由**前端**根据 state 现算（ui/app.js 的 scenePanelNode +
       src/scenePanel.js）。这里再让模型往正文里塞一张，玩家就会看到两张卡：
       一张模型放的、一张界面画的，而且它们更新时机不同，迟早对不上。
       所以雨夜侧一律不发这张卡 —— 卡片只有一个来源。 */
    if ((world?.rainLevel ?? 0) > 0) return '';
    let view = null;
    try {
      view = settings.buildView ? settings.buildView(state) : null;
    } catch {
      view = null;   // 视图算不出来不该拖垮叙事
    }
    return makeStatusCard({
      changes: report?.changes ?? [],
      state,
      view,
      world,
      labelOf: labelForPath,
      valueOf: resolveValue,
    });
  }

  /**
   * 把提示词栈装进消息列表。
   *
   * system 条目拼到系统提示**之前**（玩家自定义的写法在引擎规则之上），
   * user/assistant 条目按顺序插在对话尾部之前。
   *
   * 栈为空（或全被关掉）时原样返回 —— 不产生空消息，也不动 messages[0]。
   * 幂等：同一个 messages 传第二次不会再插一遍。
   */
  function withStack(messages) {
    const stack = settings.promptStack;
    if (!Array.isArray(stack) || stack.length === 0) return messages;

    const { system, injected } = assembleStack(stack);
    const out = messages.slice();

    if (system && out[0]?.role === 'system') {
      out[0] = { ...out[0], content: `${system}\n\n${out[0].content}` };
    }
    for (const m of injected) {
      // 插在最后一条之前，保证对话尾部是「当前这一轮」
      out.splice(Math.max(out.length - 1, 0), 0, m);
    }
    return out;
  }

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
      const intent = interpretInput(state, event, playerInput, world);

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
     * 自由对话：玩家直接说，模型直接回。不选分支、不推进事件。
     *
     * 与 narrate 的分工：narrate 写的是「引擎已经决定的那件事」，
     * freeReply 写的是「玩家刚说的那句话引出的回应」。
     * 群的开关只影响提示词与分段，模型不守格式时整段当叙述，照样能显示。
     *
     * @returns {{ segments:Array<{speaker:string|null,text:string}>, text:string,
     *             source:'model'|'none', lore?:string, error?:Error }}
     */
    async freeReply({
      state, playerText, persona = null, group = false, stream = true,
      speakerStrategy = 'natural', allowSelf = false, disabled = [],
    }) {
      if (!hasModel()) return { segments: [], text: '', source: 'none' };

      try {
        const ctx = assembleContext(state, playerText);
        const lore = loreFor(state, [playerText, ...recentTexts(state)]);

        // 在场角色 = 已见过的（met）。没见过的人不该凭空开口。
        // disabled：被关掉的成员这一轮不开口（酒馆的 disabled_members）
        const off = new Set((disabled ?? []).map(String));
        const actors = Object.entries(state.actors ?? {})
          .filter(([, a]) => a.met)
          .map(([id, a]) => ({ id, name: a.name, disabled: off.has(String(id)) }));

        // 上一轮最后开口的人 —— 用来防「同一角色连着说两段」
        const lastFree = [...(state.history ?? [])]
          .reverse()
          .find(r => Array.isArray(r.segments) && r.segments.some(s => s.speaker));
        const lastSpeaker = lastFree
          ? [...lastFree.segments].reverse().find(s => s.speaker)?.speaker ?? null
          : null;

        const speakers = group
          ? pickSpeakers({ actors, playerText, strategy: speakerStrategy, lastSpeaker, allowSelf })
              .map(a => a.name)
          : [];

        let messages = buildFreeMessages({
          brief: world.brief,
          situation: describeSituation(state, world),
          history: (state.history ?? []).slice(-12),
          playerText: ctx.inbound ?? playerText,
          persona,
          group,
          actors,
          speakers,
          lore: [lore, ctx.contextNote].filter(Boolean).join('\n\n'),
        });

        // 玩家自己的提示词栈（在预设系统提示之下、引擎规则之上）
        messages = withStack(messages);

        // 导入的预设若带系统提示词，拼在最前面（只影响「怎么说」）
        if (world.presetSystemPrompt) {
          messages[0] = {
            role: 'system',
            content: `${world.presetSystemPrompt}\n\n${messages[0].content}`,
          };
        }

        const raw = (onDelta && stream)
          ? await client.stream(messages, { temperature: 0.92, maxTokens: maxTokensForLength(settings.narrationStyle?.length) }, (_delta, full) => {
            const partial = cleanNarration(full);
            if (partial) onDelta(partial);
          })
          : await client.complete(messages, { temperature: 0.92, maxTokens: maxTokensForLength(settings.narrationStyle?.length) });

        const cleaned = cleanNarration(raw);
        const text = settings.outboundRules.length > 0
          ? applyOutbound(cleaned, settings.outboundRules).text
          : cleaned;
        if (!text) throw new LLMError('模型返回了空回复', { code: 'empty' });

        const segments = parseSegments(text, { known: actors.map(a => a.name) });
        return { segments, text: segmentsToText(segments), source: 'model', lore };
      } catch (e) {
        return { segments: [], text: '', source: 'none', error: e };
      }
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

        let messages = buildNarrationMessages({
          brief: world.brief,
          situation: describeSituation(state, world),
          event,
          branch,
          report,
          playerInput: ctx.inbound,
          world,
          lore: [lore, ctx.contextNote].filter(Boolean).join('\n\n'),
          style: settings.narrationStyle,
          statusCard: statusCardFor(state, report),
          // §9.4 禁止矩阵：模式声明的口径，原文照发
          prohibitions: world.prohibitions ?? null,
          relations: world.relations ?? null,
          playerCard: world.playerCard ?? null,
          narrativeRules: world.narrativeRules ?? null,
          // §16 触发表：只在玩家原话确实命中关键词时才注入（没命中就是空串）
          triggerHit: settings.mech('triggers')
            ? triggerNote(matchTriggers(ctx.inbound, world.triggers), state, world)
            : '',
          // §24.1 角色人设：只发有 persona 的角色（雨夜里就是林晚晴与周若宁）
          personas: (world.actorDefs ?? []).filter(a => a.persona).map(a => ({
            name: a.name,
            fields: [
              ...(a.persona.core ?? []),
              ...(a.persona.actions ?? []).map(x => `标志动作：${x}`),
              ...(a.persona.toPlayer ?? []).map(x => `对玩家：${x}`),
              ...(a.persona.stress ?? []).map(x => `压力反应：${x}`),
              ...(a.persona.selfEsteem ?? []).map(x => `自尊反应：${x}`),
            ],
          })),
        });

        // 玩家自己的提示词栈（在预设系统提示之下、引擎规则之上）
        messages = withStack(messages);

        // 导入的预设若带系统提示词，拼在最前面（预设只影响"怎么说"，不改变则）
        if (world.presetSystemPrompt) {
          messages[0] = {
            role: 'system',
            content: `${world.presetSystemPrompt}\n\n${messages[0].content}`,
          };
        }

        const raw = (onDelta && stream)
          ? await client.stream(messages, { temperature: 0.9, maxTokens: maxTokensForLength(settings.narrationStyle?.length) }, (_delta, full) => {
            const partial = cleanNarration(full);
            if (partial) onDelta(partial);
          })
          : await client.complete(messages, { temperature: 0.9, maxTokens: maxTokensForLength(settings.narrationStyle?.length) });

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

    /**
     * 运行期改文风配置。
     * 不走「重建 director」那条路 —— 重建会连 onDelta 回调一起丢，
     * 正在流的这一段就断了。改一个字段而已，直接写进去。
     */
    setNarrationStyle(style) { settings.narrationStyle = style ?? null; },

    /** 运行期开关状态卡 —— 同 setNarrationStyle，不重建 director */
    setStatusCard(on) { settings.statusCard = on !== false; },
  };
}
