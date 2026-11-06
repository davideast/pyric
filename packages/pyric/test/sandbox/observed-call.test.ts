/**
 * An observed call is read from untrusted client input and becomes one
 * `operation` event that says production served it.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, toOperationRecord, type ObservedCall } from '../../src/sandbox/index.js';
import {
  emitSandboxEvent,
  isProductionServed,
  observedCallEvent,
  ObservedCallError,
  productionVerdict,
  readObservedCall,
} from '../../src/sandbox/internal/index.js';

const DENIED_READ: ObservedCall = {
  service: 'firestore',
  method: 'getDoc',
  path: 'rooms/r1',
  at: 1_700_000_000_000,
  durationMs: 42,
  outcome: { status: 'error', code: 'permission-denied' },
  account: { uid: 'alice', claimNames: ['admin', 'email'] },
  projectId: 'my-project',
};

const NAMED_RTDB_READ: ObservedCall = {
  service: 'rtdb',
  method: 'get',
  path: '/items/a',
  at: 1_700_000_000_000,
  outcome: { status: 'ok' },
  projectId: 'my-project',
  instance: 'my-project-named',
};

describe('readObservedCall', () => {
  it('keeps every known field of a well-formed record', () => {
    expect(readObservedCall(DENIED_READ)).toEqual(DENIED_READ);
    const signedOut = { service: 'auth', method: 'signInAnonymously', at: 1, outcome: { status: 'ok' } };
    expect(readObservedCall(signedOut)).toEqual(signedOut as ObservedCall);
    for (const billedDocuments of [0, 3]) {
      const delivery = { service: 'firestore', method: 'onSnapshot', at: 1, outcome: { status: 'ok' }, billedDocuments };
      expect(readObservedCall(delivery)).toEqual(delivery as ObservedCall);
    }
  });

  it('keeps an RTDB call with its instance and path', () => {
    expect(readObservedCall(NAMED_RTDB_READ)).toEqual(NAMED_RTDB_READ);
    const denied = { ...NAMED_RTDB_READ, method: 'onDisconnect.set', instance: 'my-project-default-rtdb', outcome: { status: 'error', code: 'permission_denied' } };
    expect(readObservedCall(denied)).toEqual(denied as ObservedCall);
  });

  it('refuses a malformed record and names the field', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'call'],
      [[DENIED_READ], 'call'],
      [{ ...DENIED_READ, service: 'storage' }, 'service'],
      [{ ...DENIED_READ, instance: 'my-project-default-rtdb' }, 'instance'],
      [{ ...NAMED_RTDB_READ, instance: '' }, 'instance'],
      [{ ...NAMED_RTDB_READ, instance: 'Named' }, 'instance'],
      [{ ...NAMED_RTDB_READ, instance: '-named' }, 'instance'],
      [{ ...NAMED_RTDB_READ, instance: 'named.firebaseio.com' }, 'instance'],
      [{ ...NAMED_RTDB_READ, instance: 'a'.repeat(101) }, 'instance'],
      [{ ...NAMED_RTDB_READ, instance: 7 }, 'instance'],
      [{ ...DENIED_READ, method: 'get Doc()' }, 'method'],
      [{ ...DENIED_READ, at: Number.NaN }, 'at'],
      [{ ...DENIED_READ, at: -1 }, 'at'],
      [{ ...DENIED_READ, path: '' }, 'path'],
      [{ ...DENIED_READ, path: 'a'.repeat(1501) }, 'path'],
      [{ ...DENIED_READ, durationMs: '42' }, 'durationMs'],
      [{ ...DENIED_READ, outcome: undefined }, 'outcome'],
      [{ ...DENIED_READ, outcome: { status: 'denied' } }, 'outcome.status'],
      [{ ...DENIED_READ, outcome: { status: 'error', code: 'no spaces allowed' } }, 'outcome.code'],
      [{ ...DENIED_READ, outcome: { status: 'ok', code: 'x' } }, 'outcome.code'],
      [{ ...DENIED_READ, account: { uid: '' } }, 'account.uid'],
      [{ ...DENIED_READ, account: { uid: 'alice', token: 'eyJ...' } }, 'account.token'],
      [{ ...DENIED_READ, account: { uid: 'alice', claimNames: { admin: true } } }, 'account.claimNames'],
      [{ ...DENIED_READ, account: { uid: 'alice', claimNames: [7] } }, 'account.claimNames'],
      [{ ...DENIED_READ, caller: { kind: 'admin' } }, 'caller'],
      [{ ...DENIED_READ, id: 'forged' }, 'id'],
      [{ ...DENIED_READ, projectId: '' }, 'projectId'],
      [{ ...DENIED_READ, projectId: 'Has Spaces' }, 'projectId'],
      [{ ...DENIED_READ, projectId: 'a'.repeat(64) }, 'projectId'],
      [{ ...DENIED_READ, projectId: 7 }, 'projectId'],
      [{ ...DENIED_READ, billedDocuments: -1 }, 'billedDocuments'],
      [{ ...DENIED_READ, billedDocuments: 1.5 }, 'billedDocuments'],
      [{ ...DENIED_READ, billedDocuments: '2' }, 'billedDocuments'],
    ];
    for (const [record, field] of cases) {
      const read = () => readObservedCall(record);
      expect(read).toThrow(ObservedCallError);
      expect(read).toThrow(`Invalid observed call field: ${field}.`);
    }
  });
});

describe('observedCallEvent', () => {
  it('lands in the event stream as production-served, with the caller the host names', () => {
    const sandbox = initializeSandbox();
    emitSandboxEvent(sandbox, observedCallEvent(readObservedCall(DENIED_READ)), { caller: { kind: 'node' } });
    const [event] = sandbox.history();
    expect(event).toMatchObject({
      kind: 'operation',
      service: 'firestore',
      method: 'getDoc',
      path: 'rooms/r1',
      at: DENIED_READ.at,
      durationMs: 42,
      auth: { uid: 'alice' },
      result: 'error',
      caller: { kind: 'node' },
      production: { outcome: { status: 'error', code: 'permission-denied' }, claimNames: ['admin', 'email'] },
    });
    const record = toOperationRecord(event!);
    expect(record?.rules).toEqual({ kind: 'not-evaluated', reason: 'external-execution' });
    expect(isProductionServed(record?.rules)).toBe(true);
  });

  it('records a success with no local verdict and a signed-out call with no account', () => {
    const event = observedCallEvent({ service: 'auth', method: 'signInAnonymously', at: 5, outcome: { status: 'ok' } });
    expect(event.result).toBe('not-applicable');
    expect(event.auth).toBeNull();
    expect(event.production).toEqual({ outcome: { status: 'ok' } });
  });

  it('names a named RTDB instance on the event and leaves the default instance out', () => {
    expect(observedCallEvent(NAMED_RTDB_READ)).toMatchObject({ service: 'rtdb', method: 'get', path: '/items/a', instance: 'my-project-named' });
    for (const instance of ['my-project-default-rtdb', 'my-project']) {
      const event = observedCallEvent({ ...NAMED_RTDB_READ, instance });
      expect(event.path).toBe('/items/a');
      expect('instance' in event).toBe(false);
    }
    // Without a project, no name can be read as the default, so the event keeps it.
    const { projectId: _projectId, ...withoutProject } = NAMED_RTDB_READ;
    expect(observedCallEvent({ ...withoutProject, instance: 'my-project-default-rtdb' }).instance).toBe('my-project-default-rtdb');
  });

  it("reads production's permission-denied, in any service's spelling, as denied", () => {
    expect(productionVerdict({ status: 'ok' })).toBe('ok');
    expect(productionVerdict({ status: 'error', code: 'permission-denied' })).toBe('denied');
    expect(productionVerdict({ status: 'error', code: 'PERMISSION_DENIED' })).toBe('denied');
    expect(productionVerdict({ status: 'error', code: 'firestore/permission-denied' })).toBe('denied');
    expect(productionVerdict({ status: 'error', code: 'auth/wrong-password' })).toBe('failed');
  });

  it('leaves a sandbox-served operation unmarked', () => {
    expect(isProductionServed({ kind: 'evaluated', verdict: 'allow' })).toBe(false);
    expect(isProductionServed({ kind: 'not-evaluated', reason: 'not-a-rules-operation' })).toBe(false);
    expect(isProductionServed(undefined)).toBe(false);
  });
});
