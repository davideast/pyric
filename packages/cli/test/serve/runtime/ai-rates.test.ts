import { test, expect } from 'bun:test';
import { createSdkActivityJournal, createSdkRateMonitor } from 'pyric/sandbox/internal';
import { createRateHistory, historyHtml } from '../../../src/serve/runtime/rate-history.js';
import { createRateThresholdMonitor } from '../../../src/serve/runtime/rate-threshold-monitor.js';
import { buildRateCapture, readRateCapture } from '../../../src/serve/runtime/rate-capture.js';
import { aiRequestDetails } from '../../../src/serve/runtime/ai-request-details.js';

test('AI rates, thresholds, retained timeline and captures preserve token provenance and model identity', () => {
  let now = 1000;
  const journal = createSdkActivityJournal({ monotonicNow: () => now, now: () => now });
  const monitor = createSdkRateMonitor(journal, { monotonicNow: () => now });
  const warnings = createRateThresholdMonitor();
  const history = createRateHistory('ai');
  const app = {};
  const config = { sustainedSeconds: 2, ai: { requests: 2, inputTokens: 100, outputTokens: 100 } };
  for (let second = 1; second <= 3; second++) {
    now = second * 1000;
    for (let call = 0; call < 3; call++) {
      const activity = journal.begin({ app, kind: 'operation', method: 'generateContent', source: { service: 'ai', target: 'models/gemini-test', key: 'models/gemini-test' } });
      activity.ai({ requestedModel: 'models/gemini-test', routedModel: 'qwen', reportedModel: 'qwen-v1', engine: 'openai', usageSource: 'backend', inputTokens: 60, outputTokens: 10 });
      activity.delivered(undefined, { aiInputTokens: 60, aiOutputTokens: 10 });
      activity.complete();
    }
    warnings.sample(monitor.snapshot(), config);
    history.record(monitor.snapshot());
  }
  now = 4000;
  warnings.sample(monitor.snapshot(), config);
  expect(warnings.incidents().map(i => i.operation).sort()).toEqual(['inputTokens','requests']);
  history.pause(monitor.snapshot());
  const frame = history.view(monitor.snapshot())!;
  expect(frame.totals.requests).toBe(9);
  expect(frame.totals.inputTokens).toBe(540);
  expect(frame.totals.estimatedTokens).toBe(0);
  expect(historyHtml(frame)).toContain('Backend input tokens');
  const roundtrip = readRateCapture(JSON.stringify(buildRateCapture(frame, config, [], null))).frame;
  expect(roundtrip.totals.inputTokens).toBe(540);
  expect(roundtrip.service.aiRequests![0]!.detail.reportedModel).toBe('qwen-v1');
  expect(aiRequestDetails(roundtrip.service, value => value, roundtrip)).toContain('Requested as');
  monitor.dispose(); journal.dispose();
});

test('idle history includes delayed failed completions and unknown usage', () => {
  let now = 0;
  const journal = createSdkActivityJournal({ monotonicNow: () => now, now: () => now });
  const monitor = createSdkRateMonitor(journal, { monotonicNow: () => now });
  const activity = journal.begin({ app: {}, kind: 'operation', method: 'generateContent', source: { service: 'ai', target: 'model', key: 'model' } });
  now = 10000;
  activity.fail({ aiFailures: 1, aiUnknownUsage: 1 });
  now = 14000;
  const history = createRateHistory('ai');
  history.open(monitor.snapshot());
  expect(history.view(monitor.snapshot())!.totals.failures).toBe(1);
  expect(history.view(monitor.snapshot())!.totals.unknownUsage).toBe(1);
  monitor.dispose(); journal.dispose();
});

test('AI captures save to the project and reopen with model identity', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createRateCaptureStore } = await import('../../../src/serve/rate-capture-store.js');
  const directory = await mkdtemp(join(tmpdir(), 'ai-capture-'));
  const journal = createSdkActivityJournal();
  const monitor = createSdkRateMonitor(journal);
  try {
    const activity = journal.begin({ app: {}, method: 'generateContent', kind: 'operation', source: { service: 'ai', target: 'alias', key: 'alias' } });
    activity.ai({ requestedModel: 'alias', routedModel: 'qwen', engine: 'openai', usageSource: 'unknown' });
    activity.delivered(undefined, { aiUnknownUsage: 1 }); activity.complete();
    const history = createRateHistory('ai'); history.pause(monitor.snapshot());
    const capture = JSON.stringify(buildRateCapture(history.view(monitor.snapshot())!, {}, [], null));
    const store = createRateCaptureStore(directory);
    const saved = await store.save(capture);
    expect(saved.service).toBe('ai');
    expect((await store.list())[0]!.service).toBe('ai');
    expect(readRateCapture(await store.read(saved.id)).frame.service.aiRequests![0]!.detail.routedModel).toBe('qwen');
  } finally { monitor.dispose(); journal.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('long AI requests retain their lifecycle across progress eviction, Traffic and automatic rate selection', async () => {
  const { createActivityHistory } = await import('../../../src/serve/runtime/activity-history.js');
  const { aiTrafficRequest } = await import('../../../src/serve/runtime/chip-traffic.js');
  let now = 1000;
  const journal = createSdkActivityJournal({ now: () => now, monotonicNow: () => now });
  const monitor = createSdkRateMonitor(journal, { monotonicNow: () => now });
  const data = createActivityHistory({ now: () => now });
  const unsubscribe = journal.subscribe(event => data.record(event));
  const activity = journal.begin({ app: {}, method: 'generateContentStream', kind: 'operation', source: { service: 'ai', target: 'alias', key: 'alias' } });
  activity.ai({ requestedModel: 'alias', routedModel: 'ornith:9b', engine: 'openai', usageSource: 'backend' });
  let service = monitor.snapshot().services.find(service => service.service === 'ai')!;
  expect(service.aiInProgress).toBe(1);
  expect(aiTrafficRequest(service.aiRequests![0]!).aiRequest?.status).toBe('pending');
  for (let i = 0; i < 120; i++) { now += 125; activity.progress(); }
  activity.delivered(undefined, { aiCompleted: 1, aiInputTokens: 79, aiOutputTokens: 77 });
  activity.complete();
  now += 3000;
  const history = createRateHistory('ai'); history.open(monitor.snapshot());
  const frame = history.view(monitor.snapshot())!;
  expect(frame.totals.requests).toBe(1);
  expect(frame.totals.completed).toBe(1);
  expect(frame.totals.inputTokens).toBe(79);
  expect(data.counts({ scope: { kind: 'retained' } }).calls).toBe(1);
  service = monitor.snapshot().services.find(service => service.service === 'ai')!;
  expect(service.aiInProgress).toBe(0);
  expect(service.aiRequests).toHaveLength(1);
  expect(aiTrafficRequest(service.aiRequests![0]!).path).toBe('alias');
  expect(aiRequestDetails(service, value => value, frame)).toContain('ornith:9b');
  history.inspect(monitor.snapshot(), 16, 16);
  const completion = history.view(monitor.snapshot())!;
  expect(completion.totals.requests).toBe(0);
  expect(completion.totals.completed).toBe(1);
  expect(aiRequestDetails(service, value => value, completion)).toContain('ornith:9b');
  const saved = readRateCapture(JSON.stringify(buildRateCapture(frame, {}, [], null)));
  expect(saved.frame.service.aiRequests![0]!.startedSecond).toBe(1);
  expect(saved.frame.totals.completed).toBe(1);
  data.clear(); expect(data.counts({ scope: { kind: 'retained' } }).calls).toBe(0);
  unsubscribe(); data.dispose(); monitor.dispose(); journal.dispose();
});

test('automatic AI selection spans a request longer than the live minute', () => {
  let now = 1000;
  const journal = createSdkActivityJournal({ now: () => now, monotonicNow: () => now });
  const monitor = createSdkRateMonitor(journal, { monotonicNow: () => now });
  const history = createRateHistory('ai');
  const request = journal.begin({ app: {}, method: 'generateContent', kind: 'operation', source: { service: 'ai', target: 'alias', key: 'alias' } });
  request.ai({ requestedModel: 'alias', routedModel: 'local', engine: 'openai', usageSource: 'backend' });
  for (let i = 1; i <= 90; i++) { now = i * 1000; history.record(monitor.snapshot()); }
  request.delivered(undefined, { aiCompleted: 1, aiInputTokens: 10 }); request.complete();
  now += 3000;
  history.open(monitor.snapshot());
  const frame = history.view(monitor.snapshot())!;
  expect(frame.from).toBe(1);
  expect(frame.totals.requests).toBe(1);
  expect(frame.totals.completed).toBe(1);
  monitor.dispose(); journal.dispose();
});

test('default AI period includes spaced scripted and backend calls, while captures omit response previews', () => {
  let now = 1000;
  const journal = createSdkActivityJournal({ now: () => now, monotonicNow: () => now });
  const monitor = createSdkRateMonitor(journal, { monotonicNow: () => now });
  for (const engine of ['scripted', 'openai'] as const) {
    const request = journal.begin({ app: {}, method: 'generateContent', kind: 'operation', source: { service: 'ai', target: 'alias', key: 'alias' } });
    request.ai({ requestedModel: 'alias', engine, usageSource: engine === 'scripted' ? 'scripted' : 'backend' });
    request.response({ text: 'Retained response content' });
    request.delivered(undefined, { aiCompleted: 1, ...(engine === 'scripted' ? { aiEstimatedTokens: 10 } : { aiInputTokens: 10, aiOutputTokens: 5 }) });
    request.complete(); now += 18000;
  }
  const history = createRateHistory('ai'); history.open(monitor.snapshot());
  const frame = history.view(monitor.snapshot())!;
  expect(frame.totals.requests).toBe(2);
  expect(frame.totals.completed).toBe(2);
  expect(frame.totals.estimatedTokens).toBe(10);
  expect(frame.totals.inputTokens).toBe(10);
  expect(frame.service.aiRequests).toHaveLength(2);
  expect(frame.service.aiRequests![0]!.response?.text).toContain('Retained response content');
  const capture = JSON.stringify(buildRateCapture(frame, {}, [], null));
  expect(capture).not.toContain('Retained response content');
  expect(frame.service.aiRequests![0]!.response?.text).toContain('Retained response content');
  monitor.dispose(); journal.dispose();
});

test('worker execution history contributes once to rates and preserves missing measurements', async () => {
  const { workerAiRates } = await import('../../../src/serve/runtime/worker-ai-rates.js');
  const { createSdkRates } = await import('pyric/sandbox/internal');
  const now = Date.now();
  const requests = [{ id: 'worker-1', startedAt: now - 100, at: now, second: 0, method: 'generateContentStream', status: 'completed',
    detail: { requestedModel: 'synthetic', engine: 'scripted' as const, usageSource: 'unknown' as const } }];
  const project = workerAiRates(requests);
  const ai = project(createSdkRates().snapshot()).services.find(service => service.service === 'ai')!;
  const calls = ai.methods.flatMap(method => method.buckets).reduce((sum, bucket) => sum + bucket.calls, 0);
  expect(calls).toBe(1);
  expect(ai.usageBuckets?.reduce((total, bucket) => total + (bucket.aiCompleted ?? 0), 0)).toBe(1);
  expect(ai.usageBuckets?.reduce((total, bucket) => total + (bucket.aiUnknownUsage ?? 0), 0)).toBe(1);
  expect(ai.aiRequests?.[0]?.detail.inputTokens).toBeUndefined();
  expect(ai.aiRequests?.[0]?.detail.durationMs).toBeUndefined();
  expect(project(createSdkRates().snapshot()).services.find(service => service.service === 'ai')?.usage?.aiCompleted).toBe(0.2);
});

test('late observers recover older AI rates and keep synthetic tokens separate', async () => {
  const { workerAiRates } = await import('../../../src/serve/runtime/worker-ai-rates.js');
  const { createSdkRates } = await import('pyric/sandbox/internal');
  const now = Date.now();
  const project = workerAiRates([{ id: 'old-worker', startedAt: now - 300_000, at: now - 290_000, second: 0,
    method: 'generateContent', status: 'completed', detail: { requestedModel: 'synthetic', engine: 'scripted',
      usageSource: 'scripted', inputTokens: 10, outputTokens: 20, totalTokens: 30 } }]);
  const snapshot = project(createSdkRates().snapshot());
  const ai = snapshot.services.find(service => service.service === 'ai')!;
  expect(ai.history?.methods.flatMap(method => method.buckets).reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(1);
  expect(ai.history?.usageBuckets?.[0]).toMatchObject({ aiCompleted: 1, aiEstimatedTokens: 30 });
  expect(ai.history?.usageBuckets?.[0]?.aiInputTokens).toBeUndefined();
  const history = createRateHistory('ai');
  history.open(snapshot);
  expect(history.view(snapshot)?.totals.requests).toBe(1);
});
