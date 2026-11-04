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
};

describe('readObservedCall', () => {
  it('keeps every known field of a well-formed record', () => {
    expect(readObservedCall(DENIED_READ)).toEqual(DENIED_READ);
    const signedOut = { service: 'auth', method: 'signInAnonymously', at: 1, outcome: { status: 'ok' } };
    expect(readObservedCall(signedOut)).toEqual(signedOut as ObservedCall);
  });

  it('refuses a malformed record and names the field', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'call'],
      [[DENIED_READ], 'call'],
      [{ ...DENIED_READ, service: 'rtdb' }, 'service'],
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
