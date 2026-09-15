import { test, expect } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { getAI, getGenerativeModel } from '../../src/ai/index.js';
import { createSdkRateMonitor } from '../../src/sandbox/internal/sdk-rates.js';
import { sdkActivity } from '../../src/sandbox/internal/sdk-activity.js';
import { packAiEvidence, unpackAiEvidence } from '../../src/sandbox/internal/ai-evidence.js';
import { createTransportAI } from '../../src/ai/internal.js';
import { initializeApp } from '../../src/app/index.js';
import { AiBroker } from '../../src/ai/broker/broker.js';

function upstream(usage = true) {
  return { id: 'reply', model: 'qwen3:8b-backend', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    ...(usage ? { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } : {}) };
}
const request = { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] };

test('alias identity and backend tokens survive a call without changing the Firebase response shape', async () => {
  const sandbox = initializeSandbox();
  const monitor = createSdkRateMonitor();
  const map = { 'gemini-2.5-flash': 'qwen3:8b' };
  const model = getGenerativeModel(getAI(sandbox, { engine: { kind: 'openai', baseUrl: 'http://user:password@localhost:11434/v1?secret=x', modelMap: map, fetch: async () => new Response(JSON.stringify(upstream())) } }), { model: 'gemini-2.5-flash' });
  try {
    const result = await model.generateContent('Hello');
    expect(result.response.text()).toBe('Hello');
    expect(Object.keys(result.response)).not.toContain('__pyricAi');
    map['gemini-2.5-flash'] = 'changed';
    const stats = monitor.snapshot().services.find(s => s.service === 'ai')!;
    expect(stats.aiRequests!.at(-1)!.response?.text).toContain('Hello');
    expect(stats.aiRequests!.at(-1)!.detail).toMatchObject({ requestedModel: 'models/gemini-2.5-flash', routedModel: 'qwen3:8b', reportedModel: 'qwen3:8b-backend', engine: 'openai', endpoint: 'http://localhost:11434', usageSource: 'backend', inputTokens: 20, outputTokens: 5 });
    expect(stats.usage!.aiInputTokens).toBe(4);
    expect(stats.usage!.aiEstimatedTokens).toBe(0);
    expect(stats.aiRequests!.at(-1)!.detail.durationMs).toBeGreaterThanOrEqual(0);
  } finally { monitor.dispose(); sandbox.dispose(); }
});

test('missing OpenAI usage is estimated, while countTokens never adds generation tokens', async () => {
  const sandbox = initializeSandbox(), monitor = createSdkRateMonitor();
  const model = getGenerativeModel(getAI(sandbox, { engine: { kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'local', fetch: async () => new Response(JSON.stringify(upstream(false))) } }), { model: 'gemini-2.5-flash' });
  try {
    await model.generateContent('Hello');
    const before = monitor.snapshot().services.find(s => s.service === 'ai')!;
    await model.countTokens('Count these words');
    const after = monitor.snapshot().services.find(s => s.service === 'ai')!;
    expect(after.usage!.aiInputTokens).toBe(0);
    expect(after.usage!.aiEstimatedTokens).toBe(before.usage!.aiEstimatedTokens);
    expect(after.aiRequests!.at(-1)!.detail.usageSource).toBe('estimated');
  } finally { monitor.dispose(); sandbox.dispose(); }
});

test('worker metadata survives serialization; streaming counts once and only final backend usage counts', async () => {
  const monitor = createSdkRateMonitor();
  const broker = new AiBroker({ engine: { kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', fetch: async () => new Response([
    { model: 'qwen-reported', choices: [{ delta: { content: 'Hi' }, index: 0 }] },
    { model: 'qwen-reported', choices: [{ delta: { content: ' there' }, index: 0, finish_reason: 'stop' }] },
    { model: 'qwen-reported', choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')) } });
  const wire = <T extends object>(value: T) => unpackAiEvidence(structuredClone(packAiEvidence(value)));
  const ai = createTransportAI(initializeApp({ projectId: 'ai-flow' }, `ai-${crypto.randomUUID()}`), undefined, {
    generateContent: async (req, model) => wire(await broker.generateContent(req, model)),
    streamGenerateContent: (req, model) => (async function* () { for await (const chunk of broker.streamGenerateContent(req, model)) yield wire(chunk); })(),
    countTokens: async (req, model) => wire(await broker.countTokens(req, model)),
  });
  const phases: string[] = [];
  const stop = sdkActivity.subscribe(event => { if (event.record.service === 'ai') phases.push(event.phase); });
  try {
    const model = getGenerativeModel(ai, { model: 'gemini-2.5-flash' });
    const result = await model.generateContentStream(request);
    let chunks = 0;
    for await (const chunk of result.stream) { chunks++; expect(phases.at(-1)).toBe('progress'); expect(Object.keys(chunk)).not.toContain('__pyricAi'); }
    await result.response;
    expect(chunks).toBeGreaterThan(1);
    const preview = JSON.parse(monitor.snapshot().services.find(s => s.service === 'ai')!.aiRequests!.at(-1)!.response!.text);
    expect(preview.candidates[0].content.parts.map((part: { text?: string }) => part.text ?? '').join('')).toBe('Hi there');
    const stats = monitor.snapshot().services.find(s => s.service === 'ai')!;
    expect(stats.methods.find(m => m.method === 'generateContentStream')!.buckets.reduce((sum,b) => sum + b.calls,0)).toBe(1);
    expect(phases.filter(p => p === 'delivery')).toHaveLength(1);
    expect(stats.usage!.aiInputTokens).toBe(11/5);
    expect(stats.usage!.aiEstimatedTokens).toBe(0);
    expect(stats.aiRequests!.at(-1)!.detail).toMatchObject({ routedModel: 'qwen3:8b', reportedModel: 'qwen-reported', usageSource: 'backend' });
    expect(stats.aiRequests!.at(-1)!.detail.firstChunkMs).toBeGreaterThanOrEqual(0);
  } finally { stop(); monitor.dispose(); }
});

test('failures and unknown custom usage are recorded without invented model or tokens', async () => {
  const sandbox = initializeSandbox(), monitor = createSdkRateMonitor();
  const model = getGenerativeModel(getAI(sandbox, { engine: {
    generateContent: async () => ({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'custom' }] } }] }),
    streamGenerateContent: async function* () { throw new Error('failed'); },
    countTokens: async () => ({ totalTokens: 2, promptTokensDetails: [] }),
  } }), { model: 'gemini-2.5-flash' });
  try {
    await model.generateContent('Hello');
    const streamed = await model.generateContentStream('Hello');
    await expect(streamed.response).rejects.toThrow();
    const stats = monitor.snapshot().services.find(s => s.service === 'ai')!;
    expect(stats.usage!.aiFailures).toBe(1/5);
    expect(stats.usage!.aiUnknownUsage).toBeGreaterThan(0);
    expect(stats.aiRequests![0]!.detail.routedModel).toBeUndefined();
    expect(stats.aiRequests![0]!.detail.inputTokens).toBeUndefined();
  } finally { monitor.dispose(); sandbox.dispose(); }
});

test('countTokens snapshots configured identity before asynchronous completion', async () => {
  const { getAiEvidence } = await import('../../src/sandbox/internal/ai-evidence.js');
  const map = { alias: 'before' };
  const broker = new AiBroker({ engine: { kind: 'openai', baseUrl: 'http://localhost:11434/v1', modelMap: map } });
  const pending = broker.countTokens(request, 'models/alias');
  map.alias = 'after';
  expect(getAiEvidence(await pending)?.routedModel).toBe('before');
});
