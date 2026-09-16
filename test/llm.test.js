import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TIMEOUT,
  LLMError,
  normalizeEndpoint,
  createClient,
  readConfig,
  writeConfig,
  clearConfig,
} from '../src/llm.js';

/* ---------------------------------------------------------------- *
 * 测试替身
 * ---------------------------------------------------------------- */

async function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const okBody = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });

const configured = (extra = {}) =>
  createClient({ endpoint: 'https://api.example.com', model: 'test-model', apiKey: 'sk-secret', ...extra });

/* ---------------------------------------------------------------- *
 * 端点归一化
 * ---------------------------------------------------------------- */

test('normalizeEndpoint 补齐缺失的路径段', () => {
  assert.equal(normalizeEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(normalizeEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(normalizeEndpoint('https://x/y/chat/completions'), 'https://x/y/chat/completions');
});

test('normalizeEndpoint 处理尾斜杠与空白', () => {
  assert.equal(normalizeEndpoint('  https://a.com/  '), 'https://a.com/v1/chat/completions');
  assert.equal(normalizeEndpoint('https://a.com/v1/'), 'https://a.com/v1/chat/completions');
});

test('normalizeEndpoint 对空值返回空串', () => {
  assert.equal(normalizeEndpoint(''), '');
  assert.equal(normalizeEndpoint(null), '');
  assert.equal(normalizeEndpoint(undefined), '');
});

/* ---------------------------------------------------------------- *
 * 配置状态
 * ---------------------------------------------------------------- */

test('缺地址或缺模型都算未配置', () => {
  assert.equal(createClient({}).ready(), false);
  assert.equal(createClient({ endpoint: 'https://a.com' }).ready(), false);
  assert.equal(createClient({ model: 'm' }).ready(), false);
});

test('本地服务不需要 key 也算已配置', () => {
  const client = createClient({ endpoint: 'http://127.0.0.1:8080/v1', model: 'local' });
  assert.equal(client.ready(), true);
  assert.equal(client.describe().hasKey, false);
});

test('未配置时调用直接抛错，不发请求', async () => {
  let called = 0;
  await withFetch(() => { called += 1; }, async () => {
    const client = createClient({});
    await assert.rejects(() => client.complete([{ role: 'user', content: 'x' }]), (e) => {
      assert.ok(e instanceof LLMError);
      assert.equal(e.detail.code, 'not-configured');
      return true;
    });
  });
  assert.equal(called, 0);
});

/* ---------------------------------------------------------------- *
 * 非流式
 * ---------------------------------------------------------------- */

test('complete 正常返回文本', async () => {
  await withFetch(async () => jsonResponse(okBody('你打开了门。')), async () => {
    const text = await configured().complete([{ role: 'user', content: '写一句' }]);
    assert.equal(text, '你打开了门。');
  });
});

test('请求体带上模型名与消息', async () => {
  let captured = null;
  await withFetch(async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return jsonResponse(okBody('ok'));
  }, async () => {
    await configured().complete([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], {
      temperature: 0.3,
      maxTokens: 128,
    });
  });

  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(captured.body.model, 'test-model');
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.temperature, 0.3);
  assert.equal(captured.body.max_tokens, 128);
  assert.equal(captured.body.messages.length, 2);
});

test('带上 Authorization 头', async () => {
  let headers = null;
  await withFetch(async (_url, init) => {
    headers = init.headers;
    return jsonResponse(okBody('ok'));
  }, async () => { await configured().complete([{ role: 'user', content: 'x' }]); });

  assert.equal(headers.Authorization, 'Bearer sk-secret');
  assert.equal(headers['Content-Type'], 'application/json');
});

test('没有 key 时不发 Authorization 头', async () => {
  let headers = null;
  await withFetch(async (_url, init) => {
    headers = init.headers;
    return jsonResponse(okBody('ok'));
  }, async () => {
    await createClient({ endpoint: 'http://127.0.0.1:1/v1', model: 'm' }).complete([{ role: 'user', content: 'x' }]);
  });
  assert.equal(headers.Authorization, undefined);
});

test('HTTP 错误带上状态码，且不泄露密钥', async () => {
  await withFetch(async () => new Response('{"error":"invalid api key"}', { status: 401 }), async () => {
    await assert.rejects(() => configured().complete([{ role: 'user', content: 'x' }]), (e) => {
      assert.equal(e.detail.code, 'http');
      assert.equal(e.detail.status, 401);
      assert.match(e.message, /401/);
      assert.ok(!e.message.includes('sk-secret'), '错误信息里不能出现密钥');
      return true;
    });
  });
});

test('响应不是 JSON 时抛 bad-json', async () => {
  await withFetch(async () => new Response('<html>502</html>', { status: 200 }), async () => {
    await assert.rejects(() => configured().complete([{ role: 'user', content: 'x' }]), (e) => {
      assert.equal(e.detail.code, 'bad-json');
      return true;
    });
  });
});

test('响应结构不对时抛 bad-shape', async () => {
  await withFetch(async () => jsonResponse({ choices: [] }), async () => {
    await assert.rejects(() => configured().complete([{ role: 'user', content: 'x' }]), (e) => {
      assert.equal(e.detail.code, 'bad-shape');
      return true;
    });
  });
});

test('网络异常被包装成可读错误', async () => {
  await withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
    await assert.rejects(() => configured().complete([{ role: 'user', content: 'x' }]), (e) => {
      assert.equal(e.detail.code, 'network');
      assert.match(e.message, /连不上/);
      return true;
    });
  });
});

test('超时被识别为 timeout 而不是 network', async () => {
  await withFetch(async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }, async () => {
    await assert.rejects(() => configured().complete([{ role: 'user', content: 'x' }]), (e) => {
      assert.equal(e.detail.code, 'timeout');
      return true;
    });
  });
});

test('默认超时值是个有限的秒级数字', () => {
  assert.ok(Number.isFinite(DEFAULT_TIMEOUT));
  assert.ok(DEFAULT_TIMEOUT >= 5000);
});

/* ---------------------------------------------------------------- *
 * 流式
 * ---------------------------------------------------------------- */

test('stream 逐段回调并拼出全文', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"打开"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"了门。"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const deltas = [];

  await withFetch(async () => sseResponse(chunks), async () => {
    const full = await configured().stream([{ role: 'user', content: 'x' }], {}, (d) => deltas.push(d));
    assert.equal(full, '你打开了门。');
    assert.deepEqual(deltas, ['你', '打开', '了门。']);
  });
});

test('stream 跳过半截 JSON 行而不中断', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"甲"}}]}\n\n',
    'data: {"choices":[{"delta":{"cont\n\n',
    'data: {"choices":[{"delta":{"content":"乙"}}]}\n\n',
  ];

  await withFetch(async () => sseResponse(chunks), async () => {
    const full = await configured().stream([{ role: 'user', content: 'x' }]);
    assert.equal(full, '甲乙');
  });
});

test('stream 容忍被切断在网络包中间的行', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"conte',
    'nt":"一"}}]}\n\ndata: {"choices":[{"delta":{"content":"二"}}]}\n\n',
  ];

  await withFetch(async () => sseResponse(chunks), async () => {
    assert.equal(await configured().stream([{ role: 'user', content: 'x' }]), '一二');
  });
});

test('stream 请求体标记 stream:true', async () => {
  let body = null;
  await withFetch(async (_url, init) => {
    const parsed = JSON.parse(init.body);
    if (parsed.stream) {
      body = parsed;
      return sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']);
    }
    return jsonResponse(okBody('ok'));
  }, async () => { await configured().stream([{ role: 'user', content: 'x' }]); });
  assert.equal(body.stream, true);
});

test('服务端未吐内容时退回非流式', async () => {
  let calls = 0;
  await withFetch(async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    if (body.stream) return sseResponse(['data: [DONE]\n\n']);   // 空流
    return jsonResponse(okBody('兜底文本'));
  }, async () => {
    const text = await configured().stream([{ role: 'user', content: 'x' }]);
    assert.equal(text, '兜底文本');
    assert.equal(calls, 2, '应再发一次非流式请求');
  });
});

test('响应体不是 SSE 格式时退回非流式', async () => {
  let calls = 0;
  await withFetch(async (_url, init) => {
    calls += 1;
    const parsed = JSON.parse(init.body);
    if (parsed.stream) return new Response('这不是 SSE', { status: 200 });
    return jsonResponse(okBody('兜底文本'));
  }, async () => {
    const text = await configured().stream([{ role: 'user', content: 'x' }]);
    assert.equal(text, '兜底文本');
    assert.equal(calls, 2, '应再发一次非流式请求');
  });
});

/* ---------------------------------------------------------------- *
 * 配置读写
 * ---------------------------------------------------------------- */

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    size: () => map.size,
  };
}

test('writeConfig / readConfig 往返', () => {
  const s = fakeStorage();
  writeConfig(s, { endpoint: 'https://a.com', apiKey: 'k', model: 'm' });
  assert.deepEqual(readConfig(s), { endpoint: 'https://a.com', apiKey: 'k', model: 'm' });
});

test('clearConfig 清掉全部键', () => {
  const s = fakeStorage();
  writeConfig(s, { endpoint: 'x', apiKey: 'y', model: 'z' });
  clearConfig(s);
  assert.deepEqual(readConfig(s), { endpoint: '', apiKey: '', model: '' });
});

test('存储不可用时 readConfig 返回空值而不抛错', () => {
  const broken = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
  };
  assert.doesNotThrow(() => readConfig(broken));
  assert.deepEqual(readConfig(broken), { endpoint: '', apiKey: '', model: '' });
  assert.doesNotThrow(() => writeConfig(broken, { endpoint: 'x' }));
  assert.doesNotThrow(() => clearConfig(broken));
  assert.doesNotThrow(() => readConfig(null));
});

test('readConfig 对缺字段的存储补空串', () => {
  assert.deepEqual(readConfig(fakeStorage({ 'ne.llm.model': 'm' })), {
    endpoint: '', apiKey: '', model: 'm',
  });
});
