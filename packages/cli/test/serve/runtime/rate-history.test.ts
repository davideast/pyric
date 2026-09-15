import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { SdkRateSnapshot, SdkMethodRate } from 'pyric/sandbox/internal';
import { createRateHistory, historyHtml, bindHistory, refreshHistory } from '../../../src/serve/runtime/rate-history.js';

function snapshot(second = 20): SdkRateSnapshot {
  const method = (name: string, category: SdkMethodRate['category']): SdkMethodRate => ({
    method: name, category, observed: true, activeListeners: category === 'listener' ? 1 : 0,
    callsPerSecond: 0, deliveriesPerSecond: 0,
    buckets: Array.from({ length: 60 }, (_, index) => ({ second: index - 47,
      calls: index - 47 === 10 ? 4 : index - 47 === 11 ? 2 : 0,
      deliveries: index - 47 === 10 ? 8 : index - 47 === 11 ? 6 : 0 })),
  });
  const methods = [method('get', 'read'), method('set', 'write'), method('onValue', 'listener')];
  return { monotonicAt: second * 1000, windowSeconds: 5, services: [{ service: 'rtdb', coverage: 'partial', observed: true,
    untrackedMethods: [], lastActivityAt: 1700000011000, methods,
    history: { endSecond: 13, startedSecond: 0, methods } }] };
}

test('idle opening selects the most recent burst, using its full seconds as the denominator', () => {
  const state = createRateHistory();
  state.open(snapshot());
  const frame = state.view(snapshot())!;
  expect(frame.paused).toBe(true);
  expect([frame.from, frame.to, frame.duration]).toEqual([10, 11, 2]);
  expect(frame.totals).toEqual({ reads: 6, writes: 6, deliveries: 14, deletes: 0 });
  expect(frame.peaks).toEqual({ reads: 4, writes: 4, deliveries: 8, deletes: 0 });
  expect(frame.service.methods[0]!.callsPerSecond).toBe(3);
  expect(frame.service.methods[2]!.deliveriesPerSecond).toBe(7);
  expect(state.view(snapshot(1000))!.totals).toEqual(frame.totals);
});

test('live resumes, selection clamps to visible history and preserves zero seconds', () => {
  const state = createRateHistory(); state.open(snapshot()); state.live();
  expect(state.view(snapshot())!.paused).toBe(false);
  state.select(snapshot(), 9, 12);
  expect(state.view(snapshot())!.duration).toBe(4);
  expect(state.view(snapshot())!.service.methods[0]!.callsPerSecond).toBe(1.5);
  state.select(snapshot(), -500, 9999);
  expect([state.view(snapshot())!.from, state.view(snapshot())!.to]).toEqual([0, 20]);
});

test('opening during activity stays live and an empty service has no fabricated burst', () => {
  const state = createRateHistory(); state.open(snapshot(11));
  expect(state.view(snapshot(11))!.paused).toBe(false);
  const empty = { ...snapshot(), services: [] };
  expect(createRateHistory().view(empty)).toBeUndefined();
});

test('keyboard selection extends in both directions and refresh preserves focus', () => {
  const state = createRateHistory(); state.open(snapshot());
  const window = new JSDOM(historyHtml(state.view(snapshot())!)).window;
  const chart = window.document.querySelector<HTMLElement>('[data-history-chart]')!;
  bindHistory(window.document, state, snapshot, () => refreshHistory(window.document, state.view(snapshot())!));
  chart.focus();
  for (let i = 0; i < 2; i++) chart.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
  expect([state.view(snapshot())!.from, state.view(snapshot())!.to]).toEqual([9, 11]);
  expect(window.document.activeElement).toBe(chart);
  expect(chart.getAttribute('aria-valuetext')).toContain('to');
});

test('Firestore selects document evidence rather than SDK calls and keeps its capture independent', () => {
  const base = snapshot();
  const source = base.services[0]!;
  const usageBuckets = [
    { second: 10, documentReads: 12, documentWrites: 3, documentDeletes: 1, payloadBytes: 0, unmeasured: 0 },
    { second: 11, documentReads: 4, documentWrites: 2, documentDeletes: 0, payloadBytes: 0, unmeasured: 0 },
  ];
  const firestore = { ...source, service: 'firestore' as const, usageBuckets,
    history: { ...source.history!, usageBuckets } };
  const both = { ...base, services: [...base.services, firestore] };
  const state = createRateHistory('firestore');
  state.open(both);
  const frame = state.view(both)!;
  expect(frame.duration).toBe(2);
  expect(frame.totals).toEqual({ reads: 16, writes: 5, deletes: 1, deliveries: 0 });
  expect(frame.peaks.reads).toBe(12);
  expect(historyHtml(frame)).toContain('Document estimates per second');
  expect(historyHtml(frame)).toContain('Deletes');
  expect(historyHtml(frame)).not.toContain('Deliveries');
  expect(state.view({ ...both, monotonicAt: 1000000 })!.totals).toEqual(frame.totals);
  const rtdb = createRateHistory('rtdb');
  rtdb.open(both);
  rtdb.live();
  expect(state.view(both)!.paused).toBe(true);
});

test('incident context retains the triggering operation and clears when the period changes', () => {
  const state = createRateHistory();
  const evidence = snapshot();
  state.inspect(evidence, 10, 11, { id: 'writes/10', service: 'rtdb', operation: 'writes', label: 'Writes', limit: 1, sustainedSeconds: 2, from: 10, to: 11, peak: 4, aboveSeconds: 2, aboveRanges: [{ from: 10, to: 11 }], recovered: true, reviewed: true, at: 0, evidence });
  const document = new JSDOM(historyHtml(state.view(snapshot(1000))!)).window.document;
  expect(document.querySelector('[data-incident-context]')!.textContent).toContain('6 writes in 2 seconds');
  expect(document.querySelector('[data-incident-context]')!.textContent).toContain('4/s (4× limit)');
  expect(document.querySelector('.history-trigger-row th')!.textContent).toBe('Writes');
  state.select(evidence, 9, 12);
  refreshHistory(document, state.view(evidence)!);
  expect(document.querySelector('[data-incident-context]')!.textContent).toBe('');
  expect(document.querySelector('.history-trigger-row')).toBeNull();
});

for (const service of ['firestore', 'rtdb']) {
  test(`${service}: scrub and zoom recover older measurements after the live minute expires`, () => {
    const state = createRateHistory(service);
    const early = snapshot(20);
    early.services[0]!.service = service;
    early.services[0]!.usageBuckets = [{ second: 10, documentReads: 4, documentWrites: 6, documentDeletes: 0, payloadBytes: 0, unmeasured: 0 }];
    state.record(early);
    const late = snapshot(200);
    late.services[0]!.service = service;
    late.services[0]!.methods = [];
    late.services[0]!.history = { startedSecond: 140, endSecond: 200, methods: [] };
    late.services[0]!.usageBuckets = [];
    state.record(late);
    state.live();
    state.pan(late, 0);
    expect(state.view(late)!.totals.writes).toBe(6);
    expect(state.view(late)!.points[0]!.second).toBe(0);
    state.zoom(late, 2);
    expect(state.view(late)!.points).toHaveLength(120);
    expect(state.view(late)!.totals.writes).toBe(6);
    state.live();
    state.pan(late, 0);
    expect(state.view(late)!.totals.writes).toBe(6);
    const expired = { ...late, monotonicAt: 2000_000 };
    state.record(expired);
    state.pan(expired, 0);
    expect(state.view(expired)!.points[0]!.second).toBe(0);
    expect(state.view(expired)!.totals.writes).toBe(6);
    state.live();
    state.pan(expired, 0);
    expect(state.view(expired)!.points[0]!.second).toBe(201);
    expect(state.view(expired)!.totals.writes).toBe(0);
  });
}

test('paused navigation stays fixed while live history grows and resumes with the new bounds', () => {
  const state = createRateHistory();
  state.view(snapshot(100));
  state.zoom(snapshot(100), 0.25);
  state.pan(snapshot(100), 40);
  const paused = state.view(snapshot(100))!;
  const document = new JSDOM(historyHtml(paused)).window.document;
  const slider = document.querySelector<HTMLInputElement>('[data-history-scrubber]')!;
  const position = () => [slider.min, slider.max, slider.value];
  const before = position();
  refreshHistory(document, state.view(snapshot(140))!);
  expect(position()).toEqual(before);
  expect(state.view(snapshot(140))!.timeline).toEqual(paused.timeline);
  // Even a retention-window rollover must not move paused navigation.
  state.view(snapshot(2000));
  state.pan(snapshot(2000), 40);
  expect(state.view(snapshot(2000))!.from).toBe(40);
  state.zoom(snapshot(2000), 2);
  expect(state.view(snapshot(2000))!.timeline?.to).toBe(100);
  state.live();
  expect(state.view(snapshot(2000))!.timeline?.to).toBe(2000);
});


test('pause freezes bounds immediately, before another render occurs', () => {
  const state = createRateHistory();
  state.pause(snapshot(100));
  expect(state.view(snapshot(140))!.timeline?.to).toBe(100);
});
