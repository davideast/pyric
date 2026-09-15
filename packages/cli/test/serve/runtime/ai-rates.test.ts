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
