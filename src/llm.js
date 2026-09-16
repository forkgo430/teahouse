/**
 * 模型客户端 —— 只说 OpenAI 兼容协议的方言。
 *
 * 之所以选这个协议：DeepSeek、OpenAI、月之暗面、各类中转站都实现它，
 * 用户只要填「地址 + 模型名」就能用，不用为每家写适配。
 *
 * 三条纪律：
 *   1. **不泄露密钥**。错误信息里永远不出现 apiKey。
 *   2. **一定超时**。网络卡住时不能让界面永远转圈。
 *   3. **流式失败可降级**。拿不到流就退回非流式，拿不到任何东西就交给调用方走预写文本。
 */

export const DEFAULT_TIMEOUT = 45000;

export class LLMError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LLMError';
    this.detail = detail;
  }
}

/**
 * 把用户填的地址补成完整的 chat completions 端点。三种输入都能处理：
 *   https://api.deepseek.com       → https://api.deepseek.com/v1/chat/completions
 *   https://api.openai.com/v1      → https://api.openai.com/v1/chat/completions
 *   https://x/y/chat/completions   → 原样
 */
export function normalizeEndpoint(raw) {
  const url = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/v\d+$/i.test(url)) return `${url}/chat/completions`;
  return `${url}/v1/chat/completions`;
}

/** 从各家返回的多种形态里把文本抠出来 */
function pickContent(payload) {
  const choice = payload?.choices?.[0];
  if (!choice) return null;
  if (typeof choice?.message?.content === 'string') return choice.message.content;
  if (typeof choice?.delta?.content === 'string') return choice.delta.content;
  if (typeof choice?.text === 'string') return choice.text;
  return null;
}

export function createClient(config = {}) {
  const endpoint = normalizeEndpoint(config.endpoint);
  const apiKey = String(config.apiKey ?? '').trim();
  const model = String(config.model ?? '').trim();
  const defaultTimeout = config.timeout ?? DEFAULT_TIMEOUT;
  const defaultTemperature = config.temperature;
  const defaultMaxTokens = config.maxTokens;

  // 本地部署的服务往往不需要 key，所以 key 不是必需项
  const configured = Boolean(endpoint && model);

  async function send(messages, options = {}) {
    if (!configured) {
      throw new LLMError('模型未配置：需要填写接口地址与模型名', { code: 'not-configured' });
    }

    const { stream = false, signal, timeout = defaultTimeout, temperature, maxTokens } = options;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const relay = () => controller.abort();
    if (signal) signal.addEventListener('abort', relay);

    const body = { model, messages, stream };
    const temp = temperature ?? defaultTemperature;
    const tokens = maxTokens ?? defaultMaxTokens;
    if (temp !== undefined) body.temperature = temp;
    if (tokens !== undefined) body.max_tokens = tokens;

    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new LLMError('请求超时或被取消', { code: 'timeout' });
      }
      throw new LLMError(`连不上模型接口：${e?.message ?? e}`, { code: 'network' });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', relay);
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw new LLMError(
        `接口返回 ${res.status}${raw ? `：${raw.slice(0, 240)}` : ''}`,
        { code: 'http', status: res.status },
      );
    }

    return res;
  }

  /** 非流式：一次拿完整回复 */
  async function completeImpl(messages, options = {}) {
    const res = await send(messages, { ...options, stream: false });

    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new LLMError('接口返回的不是合法 JSON', { code: 'bad-json' });
    }

    const text = pickContent(payload);
    if (typeof text !== 'string') {
      throw new LLMError('接口响应里没有文本内容', { code: 'bad-shape' });
    }
    return text;
  }

  /**
   * 流式：边出边给。onDelta(delta, fullSoFar)
   * 若环境不支持流式读取，或服务端没吐出内容，退回非流式。
   */
  async function streamImpl(messages, options = {}, onDelta = () => {}) {
    const res = await send(messages, { ...options, stream: true });

    const reader = res.body?.getReader?.();
    if (!reader) {
      const text = await res.text();
      onDelta(text, text);
      return text;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          let json;
          try {
            json = JSON.parse(payload);
          } catch {
            continue;   // 半截 JSON 直接跳过，不能渲染给用户
          }

          const piece = pickContent(json);
          if (typeof piece === 'string' && piece) {
            full += piece;
            onDelta(piece, full);
          }
        }
      }
    } finally {
      reader.releaseLock?.();
    }

    if (!full) {
      const text = await completeImpl(messages, options);
      onDelta(text, text);
      return text;
    }

    return full;
  }

  return {
    ready: () => configured,
    describe: () => ({ endpoint, model, hasKey: Boolean(apiKey), ready: configured }),
    complete: completeImpl,
    stream: streamImpl,
  };
}

/* ------------------------------------------------------------------ *
 * 配置读写（存储不可用时静默降级为「只在本次会话有效」）
 * ------------------------------------------------------------------ */

const KEYS = {
  endpoint: 'ne.llm.endpoint',
  apiKey: 'ne.llm.key',
  model: 'ne.llm.model',
};

export function readConfig(source) {
  const get = (key) => {
    try {
      return source?.getItem?.(key) ?? '';
    } catch {
      return '';
    }
  };
  return {
    endpoint: get(KEYS.endpoint),
    apiKey: get(KEYS.apiKey),
    model: get(KEYS.model),
  };
}

export function writeConfig(target, config) {
  try {
    target?.setItem?.(KEYS.endpoint, config.endpoint ?? '');
    target?.setItem?.(KEYS.apiKey, config.apiKey ?? '');
    target?.setItem?.(KEYS.model, config.model ?? '');
  } catch {
    /* 忽略：配置只活在本次会话里 */
  }
}

export function clearConfig(target) {
  try {
    target?.removeItem?.(KEYS.endpoint);
    target?.removeItem?.(KEYS.apiKey);
    target?.removeItem?.(KEYS.model);
  } catch {
    /* 忽略 */
  }
}
