import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { doc, getDoc, getFirestore, setDoc } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import { createSdkRates, sdkActivity } from 'pyric/sandbox/internal';
import { createRateHistory } from '../../../src/serve/runtime/rate-history.js';
import { rateView } from '../../../src/serve/runtime/chip-rates.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /public/{id} { allow read, write: if true; }
    match /private/{id} { allow read, write: if false; }
  }
}`;

function createClockedRateMonitor(monotonicNow: () => number) {
  const rates = createSdkRates({ monotonicNow });
  const dispose = sdkActivity.observe((event) => {
    const stamped = monotonicNow();
    rates.record({ ...event, monotonicAt: stamped, at: 1_700_000_000_000 + stamped });
  });
  return { snapshot: rates.snapshot, dispose };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

function periodCallsFor(bodyHtml: string, method: string): string | null {
  const docDom = new JSDOM(bodyHtml).window.document;
  return docDom.querySelector(`[data-rate-method="${method}"] [data-period-calls]`)?.textContent ?? null;
}

describe('rate history active selection with denied SDK calls (#1077)', () => {
  it('includes a trailing denied getDoc in the paused burst selection so Calls shows 151', async () => {
    let nowMs = 10_000;
    const monitor = createClockedRateMonitor(() => nowMs);
    try {
      const sandbox = initializeSandbox();
      setRules(sandbox, RULES);
      const db = getFirestore(sandbox);
      await setDoc(doc(db, 'public/item'), { ok: true });

      for (let i = 0; i < 150; i += 1) {
        await getDoc(doc(db, 'public/item'));
      }

      // 2s later (still within the <= 2s contiguous run), a denied getDoc reads 0 documents.
      nowMs = 12_000;
      await expect(getDoc(doc(db, 'private/denied'))).rejects.toThrow();

      // Open Firestore in Rates 3s after the denied call (>= 2s idle).
      nowMs = 15_000;
      const snap = monitor.snapshot();
      const history = createRateHistory('firestore');
      history.open(snap);
      const frame = history.view(snap);
      expect(frame).toBeDefined();
      if (!frame) return;

      expect(frame.paused).toBe(true);
      expect([frame.from, frame.to]).toEqual([10, 12]);
      // Document read estimates remain 150 (the denied getDoc read 0 documents).
      expect(frame.totals.reads).toBe(150);

      const rendered = rateView(snap, 'firestore', (s) => s, escapeHtml, frame, '', new Map(), 'measurements');
      expect(periodCallsFor(rendered.body, 'getDoc')).toBe('151');
    } finally {
      monitor.dispose();
    }
  });

  it('treats a denied getDoc 3s after a burst as recent activity so immediate open shows 151 calls', async () => {
    let nowMs = 10_000;
    const monitor = createClockedRateMonitor(() => nowMs);
    try {
      const sandbox = initializeSandbox();
      setRules(sandbox, RULES);
      const db = getFirestore(sandbox);
      await setDoc(doc(db, 'public/item'), { ok: true });

      for (let i = 0; i < 150; i += 1) {
        await getDoc(doc(db, 'public/item'));
      }

      // Denied getDoc 3s after the burst, then open Firestore in Rates immediately.
      nowMs = 13_000;
      await expect(getDoc(doc(db, 'private/denied'))).rejects.toThrow();

      nowMs = 14_000;
      const snap = monitor.snapshot();
      const history = createRateHistory('firestore');
      history.open(snap);
      const frame = history.view(snap);
      expect(frame).toBeDefined();
      if (!frame) return;

      // Without #1077, open() measured 14 - 10 = 4 >= 2s idle, paused on [10, 10], and showed 150.
      expect(frame.paused).toBe(false);
      const rendered = rateView(snap, 'firestore', (s) => s, escapeHtml, frame, '', new Map(), 'measurements');
      expect(periodCallsFor(rendered.body, 'getDoc')).toBe('151');
    } finally {
      monitor.dispose();
    }
  });

  it('selects the denied-only second when pausing after a 3s gap following a burst and after 2s idle', async () => {
    let nowMs = 10_000;
    const monitor = createClockedRateMonitor(() => nowMs);
    try {
      const sandbox = initializeSandbox();
      setRules(sandbox, RULES);
      const db = getFirestore(sandbox);
      await setDoc(doc(db, 'public/item'), { ok: true });

      for (let i = 0; i < 150; i += 1) {
        await getDoc(doc(db, 'public/item'));
      }

      nowMs = 13_000;
      await expect(getDoc(doc(db, 'private/denied'))).rejects.toThrow();

      // Idle 3s after the isolated denied attempt: pauses on [13, 13] rather than stale [10, 10].
      nowMs = 16_000;
      const snap = monitor.snapshot();
      const history = createRateHistory('firestore');
      history.open(snap);
      const frame = history.view(snap);
      expect(frame).toBeDefined();
      if (!frame) return;

      expect(frame.paused).toBe(true);
      expect([frame.from, frame.to]).toEqual([13, 13]);
      expect(frame.totals.reads).toBe(0);
      const rendered = rateView(snap, 'firestore', (s) => s, escapeHtml, frame, '', new Map(), 'measurements');
      expect(periodCallsFor(rendered.body, 'getDoc')).toBe('1');
    } finally {
      monitor.dispose();
    }
  });
});
