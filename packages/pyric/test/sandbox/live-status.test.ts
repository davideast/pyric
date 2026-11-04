/**
 * What every live mode view shows beside its rows: the project line, read
 * from the host's health report, and the running count of billed calls,
 * folded from the observed events the host writes.
 */
import { describe, expect, it } from 'bun:test';
import type { ObservedCall, SandboxEvent } from '../../src/sandbox/index.js';
import {
  billedCallKind,
  billedCallSummary,
  createBilledCallCounter,
  liveLabel,
  observedCallEvent,
  readLiveHostStatus,
} from '../../src/sandbox/internal/index.js';

function observed(method: string, outcome: ObservedCall['outcome'] = { status: 'ok' }, service: ObservedCall['service'] = 'firestore'): SandboxEvent {
  return observedCallEvent({ service, method, at: 1_700_000_000_000, outcome });
}

describe('billedCallKind', () => {
  it('counts each successful Firestore read, write and listener delivery production answered', () => {
    for (const method of ['getDoc', 'getDocs', 'getDocFromServer', 'getDocsFromServer', 'getCountFromServer', 'getAggregateFromServer']) {
      expect(billedCallKind(observed(method)), method).toBe('read');
    }
    for (const method of ['setDoc', 'updateDoc', 'deleteDoc', 'addDoc', 'runTransaction']) {
      expect(billedCallKind(observed(method)), method).toBe('write');
    }
    for (const method of ['onSnapshot', 'onSnapshotResume']) expect(billedCallKind(observed(method)), method).toBe('delivery');
  });

  it('leaves out failures, cache reads, Auth calls and every event the sandbox served', () => {
    expect(billedCallKind(observed('getDoc', { status: 'error', code: 'permission-denied' }))).toBeNull();
    expect(billedCallKind(observed('onSnapshot', { status: 'error', code: 'unavailable' }))).toBeNull();
    expect(billedCallKind(observed('getDocFromCache'))).toBeNull();
    expect(billedCallKind(observed('getDocsFromCache'))).toBeNull();
    expect(billedCallKind(observed('signInAnonymously', { status: 'ok' }, 'auth'))).toBeNull();
    const served = { ...observed('getDoc'), production: undefined, rulesDisposition: { kind: 'evaluated', verdict: 'allow' } } as unknown as SandboxEvent;
    expect(billedCallKind(served)).toBeNull();
  });
});

describe('createBilledCallCounter', () => {
  it('keeps a running count, and counts an event delivered twice once', () => {
    const counter = createBilledCallCounter();
    expect(counter.count()).toEqual({ reads: 0, writes: 0, deliveries: 0 });
    const read = observed('getDoc');
    expect(counter.add([read, observed('setDoc'), observed('onSnapshot'), observed('onSnapshot')])).toBe(true);
    // A reconnect redelivers history: the same events add nothing.
    expect(counter.add([read])).toBe(false);
    expect(counter.add([observed('getDocFromCache')])).toBe(false);
    expect(counter.count()).toEqual({ reads: 1, writes: 1, deliveries: 2 });
  });
});

describe('billedCallSummary', () => {
  it('names each kind with its count', () => {
    expect(billedCallSummary({ reads: 1, writes: 0, deliveries: 2 })).toBe('1 read, 0 writes, 2 listener deliveries');
    expect(billedCallSummary({ reads: 3, writes: 1, deliveries: 1 })).toBe('3 reads, 1 write, 1 listener delivery');
  });
});

describe('the live project line', () => {
  it('reads "Live: <project-id>"', () => {
    expect(liveLabel('my-project')).toBe('Live: my-project');
  });

  it("is read from a health report's live field, and absent on a sandbox host", () => {
    expect(readLiveHostStatus({ status: 'ok', live: { projectId: 'my-project' } })).toEqual({ projectId: 'my-project' });
    expect(readLiveHostStatus({ status: 'ok', mode: 'sandbox' })).toBeNull();
    expect(readLiveHostStatus({ live: { projectId: '' } })).toBeNull();
    expect(readLiveHostStatus({ live: { projectId: 7 } })).toBeNull();
    expect(readLiveHostStatus(null)).toBeNull();
  });
});
