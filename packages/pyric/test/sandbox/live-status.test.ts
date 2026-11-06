/**
 * A live host's status: the project the chip and Studio name, the mismatch
 * warning the terminal prints, read from the host's health report, and the
 * count of billed calls the host keeps.
 */
import { describe, expect, it } from 'bun:test';
import type { ObservedCall } from '../../src/sandbox/index.js';
import {
  billedCallKind,
  createBilledCallCounter,
  createLiveStatusPoller,
  liveMismatchLine,
  liveProjectOf,
  readLiveHostStatus,
} from '../../src/sandbox/internal/index.js';

function call(method: string, outcome: ObservedCall['outcome'] = { status: 'ok' }, service: ObservedCall['service'] = 'firestore'): ObservedCall {
  return { service, method, at: 1_700_000_000_000, outcome };
}

const LIVE = {
  projectId: 'my-project',
  configProjectId: 'my-project',
  configSource: '.firebaserc',
  appProjectIds: ['my-project'],
  billed: { reads: 1, writes: 0, deliveries: 2 },
};

describe('billedCallKind', () => {
  it('counts each successful Firestore read, write and listener delivery production answered', () => {
    for (const method of ['getDoc', 'getDocs', 'getDocFromServer', 'getDocsFromServer', 'getCountFromServer', 'getAggregateFromServer']) {
      expect(billedCallKind(call(method)), method).toBe('read');
    }
    for (const method of ['setDoc', 'updateDoc', 'deleteDoc', 'addDoc', 'runTransaction']) {
      expect(billedCallKind(call(method)), method).toBe('write');
    }
    for (const method of ['onSnapshot', 'onSnapshotResume']) expect(billedCallKind(call(method)), method).toBe('delivery');
  });

  it('leaves out failures, cache reads and Auth calls', () => {
    expect(billedCallKind(call('getDoc', { status: 'error', code: 'permission-denied' }))).toBeNull();
    expect(billedCallKind(call('onSnapshot', { status: 'error', code: 'unavailable' }))).toBeNull();
    expect(billedCallKind(call('getDocFromCache'))).toBeNull();
    expect(billedCallKind(call('getDocsFromCache'))).toBeNull();
    expect(billedCallKind(call('signInAnonymously', { status: 'ok' }, 'auth'))).toBeNull();
  });
});

describe('createBilledCallCounter', () => {
  it('keeps a running count by kind', () => {
    const counter = createBilledCallCounter();
    expect(counter.count()).toEqual({ reads: 0, writes: 0, deliveries: 0 });
    for (const kind of ['read', 'write', 'delivery', 'delivery'] as const) counter.add(kind);
    expect(counter.count()).toEqual({ reads: 1, writes: 1, deliveries: 2 });
  });

  it('counts a listener delivery once per document it was billed for, and a metadata-only one not at all', () => {
    const counter = createBilledCallCounter();
    const deliveries = [3, 1, 0, 1].map((billedDocuments) => ({ ...call('onSnapshot'), billedDocuments }));
    for (const delivery of [...deliveries, call('onSnapshot'), call('getDoc')]) counter.addCall(delivery);
    expect(counter.count()).toEqual({ reads: 1, writes: 0, deliveries: 6 });
    expect(billedCallKind({ ...call('onSnapshot'), billedDocuments: 0 })).toBeNull();
  });
});

describe('the live project line', () => {
  it('names the projects the app called, else the host project', () => {
    expect(liveProjectOf([], 'staging')).toBe('staging');
    expect(liveProjectOf(['prod'], 'staging')).toBe('prod');
    expect(liveProjectOf(['prod', 'other'], 'staging')).toBe('prod, other');
  });

  it('warns when the app\'s Firebase config names another project than the host', () => {
    expect(liveMismatchLine({ appProjectIds: ['prod'], configProjectId: 'staging', configSource: '.firebaserc' }))
      .toBe('Your Firebase config says prod; .firebaserc says staging.');
    expect(liveMismatchLine({ appProjectIds: ['staging'], configProjectId: 'staging', configSource: '.firebaserc' })).toBeNull();
    expect(liveMismatchLine({ appProjectIds: [], configProjectId: 'staging', configSource: '.firebaserc' })).toBeNull();
  });

  it("is read from a health report's live field, and absent on a sandbox host", () => {
    expect(readLiveHostStatus({ status: 'ok', live: LIVE })).toEqual(LIVE);
    expect(readLiveHostStatus({ status: 'ok', mode: 'sandbox' })).toBeNull();
    expect(readLiveHostStatus({ live: { ...LIVE, projectId: '' } })).toBeNull();
    expect(readLiveHostStatus({ live: { ...LIVE, projectId: 7 } })).toBeNull();
    expect(readLiveHostStatus({ live: { ...LIVE, billed: { reads: -1, writes: 0, deliveries: 0 } } })).toBeNull();
    expect(readLiveHostStatus({ live: { ...LIVE, appProjectIds: [''] } })).toBeNull();
    expect(readLiveHostStatus(null)).toBeNull();
  });

  it('reads the imports the app resolved to live rows, and refuses anything but a list of firebase/* imports', () => {
    const observed = ['firebase/firestore', 'firebase/auth'];
    expect(readLiveHostStatus({ live: { ...LIVE, observed } })).toEqual({ ...LIVE, observed });
    expect(readLiveHostStatus({ live: LIVE })).not.toHaveProperty('observed');
    expect(readLiveHostStatus({ live: { ...LIVE, observed: 'firebase/firestore' } })).toBeNull();
    expect(readLiveHostStatus({ live: { ...LIVE, observed: ['firebase/firestore', 'lodash'] } })).toBeNull();
    expect(readLiveHostStatus({ live: { ...LIVE, observed: ['firebase/firestore', 7] } })).toBeNull();
  });
});

describe('createLiveStatusPoller', () => {
  function clock() {
    let now = 0;
    const due = new Map<number, { at: number; run: () => void }>();
    let next = 0;
    return {
      timers: {
        setTimeout: (run: () => void, ms: number) => { next += 1; due.set(next, { at: now + ms, run }); return next; },
        clearTimeout: (handle: unknown) => { due.delete(handle as number); },
        now: () => now,
      },
      async advance(ms: number) {
        now += ms;
        for (const [handle, timer] of [...due]) if (timer.at <= now) { due.delete(handle); timer.run(); }
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      },
    };
  }

  it('reads soon after traffic, and steady traffic never holds the read back', async () => {
    const time = clock();
    let reads = 0;
    const poller = createLiveStatusPoller(async () => { reads += 1; return LIVE; }, () => undefined, time.timers);
    poller.start();
    await time.advance(0);
    expect(reads).toBe(1);
    for (let step = 0; step < 4; step += 1) {
      poller.refreshSoon();
      await time.advance(50);
    }
    // Traffic every 50ms: the read due 150ms after the first event still ran.
    expect(reads).toBe(2);
    poller.dispose();
  });
});
