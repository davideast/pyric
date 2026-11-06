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

  it('counts a one-shot call by the documents production billed it for', () => {
    const counter = createBilledCallCounter();
    const calls: ObservedCall[] = [
      { ...call('getDocs'), usage: { documentReads: 3, payloadBytes: 120 } },
      { ...call('getCountFromServer'), usage: { documentReads: 2 } },
      { ...call('getAggregateFromServer'), usage: { documentReads: 1, unmeasured: 1 } },
      { ...call('setDoc'), usage: { documentWrites: 1 } },
      { ...call('deleteDoc'), usage: { documentDeletes: 1 } },
      { ...call('runTransaction'), usage: { documentWrites: 1, unmeasured: 1 } },
    ];
    for (const observed of calls) counter.addCall(observed);
    expect(counter.count()).toEqual({ reads: 6, writes: 3, deliveries: 0 });
  });

  it('counts a call once when its usage is missing or names no documents', () => {
    const counter = createBilledCallCounter();
    const calls: ObservedCall[] = [call('getDocs'), { ...call('getDocs'), usage: {} }, { ...call('setDoc'), usage: {} }];
    for (const observed of calls) counter.addCall(observed);
    expect(counter.count()).toEqual({ reads: 2, writes: 1, deliveries: 0 });
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

  it('reads the Admin pass-through, and drops a malformed one without losing the status', () => {
    const admin = { mode: 'pass-through', observed: false, bypassesRules: true };
    expect(readLiveHostStatus({ live: { ...LIVE, admin } })).toEqual({ ...LIVE, admin });
    expect(readLiveHostStatus({ live: LIVE })).not.toHaveProperty('admin');
    expect(readLiveHostStatus({ live: { ...LIVE, admin: { ...admin, mode: 'observed' } } })).toEqual(LIVE);
    expect(readLiveHostStatus({ live: { ...LIVE, admin: 'pass-through' } })).toEqual(LIVE);
  });

  it('reads the clients connected to the host, and drops a malformed entry without losing the status', () => {
    const page = { kind: 'browser', clientId: 'profile-1', label: '/orders', user: 'user-1', lastSeen: 1000 };
    const worker = { kind: 'service-worker', clientId: 'profile-1', user: null, lastSeen: 1000 };
    expect(readLiveHostStatus({ live: { ...LIVE, clients: [page, worker] } })).toEqual({ ...LIVE, clients: [page, worker] });
    expect(readLiveHostStatus({ live: LIVE })).not.toHaveProperty('clients');
    const malformed = [{ ...page, kind: 'tab' }, { ...page, lastSeen: 'now' }, { ...page, user: 7 }, null, worker];
    expect(readLiveHostStatus({ live: { ...LIVE, clients: malformed } })).toEqual({ ...LIVE, clients: [worker] });
    expect(readLiveHostStatus({ live: { ...LIVE, clients: 'all' } })).toEqual(LIVE);
    const many = Array.from({ length: 200 }, (_, n) => ({ ...worker, clientId: `c-${n}` }));
    expect(readLiveHostStatus({ live: { ...LIVE, clients: many } })?.clients).toHaveLength(64);
  });

  it('reads the email a browser client reports, and drops an entry whose email is not text', () => {
    const page = { kind: 'browser', clientId: 'profile-1', label: '/', user: 'user-1', email: 'ada@example.com', lastSeen: 1000 };
    expect(readLiveHostStatus({ live: { ...LIVE, clients: [page] } })?.clients).toEqual([page]);
    expect(readLiveHostStatus({ live: { ...LIVE, clients: [{ ...page, email: 7 }] } })).toEqual(LIVE);
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
