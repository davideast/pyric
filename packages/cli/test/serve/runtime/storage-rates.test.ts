import { expect, test } from 'bun:test';
import { createSdkActivityJournal, createSdkRates } from 'pyric/sandbox/internal';
import { createRateHistory, historyHtml } from '../../../src/serve/runtime/rate-history.js';
import { createRateThresholdMonitor } from '../../../src/serve/runtime/rate-threshold-monitor.js';
import { buildRateCapture, readRateCapture } from '../../../src/serve/runtime/rate-capture.js';
import { readThresholdConfig } from '../../../src/serve/runtime/rate-threshold-config.js';

test('Storage calls and bytes survive history selection, warning evidence and capture round trips', () => {
  let now = 0;
  const journal = createSdkActivityJournal({ monotonicNow: () => now });
  const rates = createSdkRates({ monotonicNow: () => now });
  journal.observe(rates.record);
  const app = {};
  const source = { service: 'storage' as const, target: 'bucket/photo', key: 'bucket/photo' };
  const monitor = createRateThresholdMonitor();
  const config = readThresholdConfig({ sustainedSeconds: 2, storage: { writes: 1, reads: null, deletes: 1 } });
  const history = createRateHistory('storage');
  for (let second = 0; second < 2; second++) {
    now = second * 1000;
    for (let i = 0; i < 2; i++) journal.begin({ app, source, method: 'uploadBytes', kind: 'operation' }).complete({ uploadedBytes: 16384 });
    now += 1000;
    history.record(rates.snapshot()); monitor.sample(rates.snapshot(), config, 100000 + now);
  }
  journal.begin({ app, source, method: 'getBytes', kind: 'operation' }).delivered(undefined, { downloadedBytes: 16384 });
  journal.begin({ app, source, method: 'deleteObject', kind: 'operation' }).complete();
  history.select(rates.snapshot(), 0, 2);
  const frame = history.view(rates.snapshot())!;
  expect(frame.totals).toMatchObject({ reads: 1, writes: 4, deletes: 1, uploadedBytes: 65536, downloadedBytes: 16384 });
  expect(monitor.incidents()).toHaveLength(1);
  expect(monitor.incidents()[0]).toMatchObject({ service: 'storage', operation: 'writes', peak: 2, aboveSeconds: 2 });
  const capture = buildRateCapture(frame, config, []);
  const reopened = readRateCapture(JSON.stringify(capture));
  expect(reopened.frame.totals).toEqual(frame.totals);
  expect(reopened.thresholds.storage?.writes).toBe(1);
  const html = historyHtml(reopened.frame);
  expect(html).toContain('Uploaded bytes');
  expect(html).toContain('Downloaded bytes');
  expect(html).not.toContain('>Deliveries<');
  expect(capture.measurement.notes.some(note => note.text.includes('not billed'))).toBe(true);
});
