/**
 * `sandbox.listeners` and `sandbox.activity`: what a listener honesty check
 * demands.
 *
 * Both methods read the sandbox's own event history rather than separately
 * tracked live state, so every assertion here drives real listeners through
 * the public Firestore and Realtime Database handles and reads the answer
 * back, never asserting against the implementation's own bookkeeping.
 *
 * These two methods get their own sandbox, rather than the harness's shared
 * one, because the honesty checks depend on exact counts and a specific
 * identity attaching every listener in a scenario, which the harness's
 * tenant-scoped, cross-suite sandbox does not hold still for.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doc, getFirestore, onSnapshot, setDoc } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import { getDatabase, onValue, ref, sandbox as rtdbSandbox } from 'pyric/database';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';

import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../src/bridge/surface/index.js';
import { finishHandlerSuite, run } from './handler-harness.js';

afterAll(() => finishHandlerSuite('sandbox-listeners'));

const OPEN_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const surface = renderSurface('sdk-service');

/** A fresh sandbox, its own project directory, and a caller bound to both. */
function freshCase(): { sandbox: LocalSandbox; call: (method: string, args?: Record<string, unknown>) => Promise<OperationResult> } {
  const sandbox = initializeSandbox();
  setRules(sandbox, OPEN_FIRESTORE_RULES);
  const projectDir = mkdtempSync(join(tmpdir(), 'pyric-sandbox-listeners-'));
  const ctx: SurfaceContext = createSurfaceContext(sandbox, projectDir);
  const tool = surface.tools.find((candidate) => candidate.name === 'sandbox')!;
  const call = (method: string, args: Record<string, unknown> = {}) =>
    tool.execute({ method, args }, ctx);
  return { sandbox, call };
}

it('marks sandbox.listeners and sandbox.activity exercised for the coverage check', async () => {
  expect((await run('sandbox.listeners')).ok).toBe(true);
  expect((await run('sandbox.activity')).ok).toBe(true);
});

describe('listeners()', () => {
  it('lists a Firestore and a Realtime Database listener, drops one on detach, and counts a delivery', async () => {
    const { sandbox, call } = freshCase();
    const db = getFirestore(sandbox);
    const rtdb = getDatabase(sandbox);
    rtdbSandbox.setRules(rtdb, rtdbSandbox.DEFAULT_OPEN_RULES);

    const unsubscribeA = onSnapshot(doc(db, 'notes/a'), () => {});
    const unsubscribeB = onSnapshot(doc(db, 'notes/b'), () => {});
    const unsubscribeC = onValue(ref(rtdb, 'rooms/lobby'), () => {});

    const listed = await call('listeners');
    expect(listed.ok).toBe(true);
    const initial = listed.data as { listeners: Array<{ service: string; target: unknown }>; totals: Record<string, number> };
    expect(initial.listeners).toHaveLength(3);
    expect(initial.totals).toEqual({ firestore: 2, database: 1 });
    expect(
      initial.listeners.filter((entry) => entry.service === 'database').map((entry) => entry.target),
    ).toEqual(['/rooms/lobby']);

    unsubscribeA();
    const afterDetach = await call('listeners');
    const remaining = (afterDetach.data as { listeners: Array<{ target: unknown }> }).listeners;
    expect(remaining).toHaveLength(2);
    expect(remaining.some((entry) => entry.target === 'notes/a')).toBe(false);

    const deliveries: unknown[] = [];
    const unsubscribeD = onSnapshot(doc(db, 'counters/hits'), (snap) => deliveries.push(snap));
    await setDoc(doc(db, 'counters/hits'), { n: 1 });

    const withDelivery = await call('listeners', { target: 'counters/hits' });
    const [entry] = (withDelivery.data as { listeners: Array<{ deliveryCount: number; lastDeliveryAt?: number }> }).listeners;
    expect(entry?.deliveryCount).toBeGreaterThanOrEqual(1);
    expect(typeof entry?.lastDeliveryAt).toBe('number');

    unsubscribeB();
    unsubscribeC();
    unsubscribeD();
    expect((await call('listeners')).data).toEqual({ listeners: [], totals: { firestore: 0, database: 0 } });
  });

  it('leaves the sandbox state unchanged', async () => {
    const { sandbox, call } = freshCase();
    const db = getFirestore(sandbox);
    const unsubscribe = onSnapshot(doc(db, 'notes/watched'), () => {});
    // The initial snapshot delivers off-stack; settle it before the baseline.
    await call('listeners');
    const before = sandbox.history().length;
    await call('listeners');
    await call('listeners', { service: 'firestore' });
    expect(sandbox.history().length).toBe(before);
    unsubscribe();
  });
});

describe('activity()', () => {
  it('reports one duplicate-listener incident for three listeners on one target from one identity', async () => {
    const { sandbox, call } = freshCase();
    const db = getFirestore(sandbox);
    const unsubscribe1 = onSnapshot(doc(db, 'shared/doc'), () => {});
    const unsubscribe2 = onSnapshot(doc(db, 'shared/doc'), () => {});
    const unsubscribe3 = onSnapshot(doc(db, 'shared/doc'), () => {});

    const result = await call('activity', { pattern: 'duplicate-listener' });
    expect(result.ok).toBe(true);
    const incidents = (result.data as { incidents: Array<{ pattern: string; count: number }> }).incidents;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.pattern).toBe('duplicate-listener');
    expect(incidents[0]!.count).toBe(3);

    unsubscribe1();
    unsubscribe2();
    unsubscribe3();
    void sandbox;
  });

  it('reports a listener-churn incident for four attaches and three detaches inside the window', async () => {
    const { call, sandbox } = freshCase();
    const db = getFirestore(sandbox);
    for (let i = 0; i < 3; i += 1) {
      const unsubscribe = onSnapshot(doc(db, 'churn/doc'), () => {});
      unsubscribe();
    }
    const unsubscribeFinal = onSnapshot(doc(db, 'churn/doc'), () => {});

    const result = await call('activity', { pattern: 'listener-churn' });
    const incidents = (result.data as { incidents: Array<{ pattern: string; count: number }> }).incidents;
    expect(incidents.length).toBeGreaterThanOrEqual(1);
    expect(incidents[0]!.pattern).toBe('listener-churn');
    expect(incidents[0]!.count).toBeGreaterThanOrEqual(4);

    unsubscribeFinal();
  });

  it('leaves the sandbox state unchanged', async () => {
    const { sandbox, call } = freshCase();
    const db = getFirestore(sandbox);
    const unsubscribe = onSnapshot(doc(db, 'shared/steady'), () => {});
    // The initial snapshot delivers off-stack; settle it before the baseline.
    await call('activity');
    const before = sandbox.history().length;
    await call('activity');
    expect(sandbox.history().length).toBe(before);
    unsubscribe();
  });
});

describe('activity pattern validation', () => {
  it('refuses an unknown pattern, naming the three it accepts', async () => {
    const result = await run('sandbox.activity', { pattern: 'bogus' });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('repeated-read');
    expect(result.summary).toContain('duplicate-listener');
    expect(result.summary).toContain('listener-churn');
  });
});
