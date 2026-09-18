/**
 * 提示词栈 —— 酒馆 Prompt Manager 的轻量版。
 *
 * 栈里是一组有序的条目：{ id, name, role, content, enabled, injectionPosition }。
 * 构建消息时按顺序拼接启用的条目：
 *   system 条目 → 拼进系统提示
 *   user/assistant 条目 → 作为独立消息插在对话尾部之前
 *
 * 与预设（preset）打通：导入预设生成的栈可直接装进来。
 */

/** 默认栈：引擎自己的叙事规则永远在，用户条目排在它后面 */
export function defaultStack(engineSystemPrompt) {
  return [
    {
      id: 'engine-core',
      name: '引擎叙事规则',
      role: 'system',
      content: engineSystemPrompt ?? '',
      enabled: true,
      locked: true,   // 引擎规则不可关闭（关了模型会乱改数值叙述）
      order: 0,
    },
  ];
}
/** 归一化一条外部栈条目（酒馆 prompts 数组的形状） */
export function normalizePromptEntry(raw = {}, index = 0) {
  return {
    id: raw.id ?? raw.identifier ?? `P${index + 1}`,
    name: raw.name ?? raw.comment ?? `条目 ${index + 1}`,
    role: raw.role ?? 'system',
    content: typeof raw.content === 'string' ? raw.content : '',
    enabled: raw.enabled !== false,
    order: Number.isFinite(raw.order) ? raw.order : index,
    locked: false,
  };
}

/**
 * 把启用的栈条目装配成消息数组的前缀与插入消息。
 * @returns {{ system: string, injected: Array<{role:string,content:string}> }}
 */
export function assembleStack(stack, { userPrompt = '', charPrompt = '' } = {}) {
  const entries = (stack ?? [])
    .filter(e => e.enabled && e.content?.trim())
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const systemParts = [];
  const injected = [];

  for (const e of entries) {
    let content = e.content;
    if (e.id === 'engine-core') continue;   // 占位：内容由调用方提供
    if (content === '{{original}}') continue;

    if (e.role === 'system') {
      systemParts.push(content);
    } else {
      injected.push({ role: e.role === 'assistant' ? 'assistant' : 'user', content });
    }
    void userPrompt;
    void charPrompt;
  }

  return { system: systemParts.join('\n\n'), injected };
}

/** 把栈 + 引擎系统提示组装成 chat messages 的 system 项 */
export function buildSystemMessage(stack, engineSystem) {
  const { system } = assembleStack(stack);
  const parts = [];
  if (system) parts.push(system);
  if (engineSystem) parts.push(engineSystem);
  return parts.join('\n\n');
}
