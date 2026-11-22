/**
 * Ledger A8 (#1379): a `mergeFields` write naming a field missing from the
 * input data must be refused in `LocalEnvironment.execute` like every other
 * invalid-argument write, returning an `invalid-argument` denial, recording
 * one request event, recording zero write events, and leaving the document
 * unchanged.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import { LocalEnvironment, getInternalEnv } from '../../../../src/sandbox/internal/index.js';
import type { RequestEvent, WriteSandboxEvent } from '../../../../src/sandbox/types/events.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

function createOpenEnv(documents: Record<string, Record<string, unknown>> = {}): LocalEnvironment {
  const env = new LocalEnvironment();
  env.seed({ rules: OPEN_RULES, documents });
  return env;
}

describe('ledger A8 (#1379): mergeFields missing field refuses with invalid-argument and request event', () => {
  it('LocalEnvironment.execute update with missing mergeFields denies with invalid-argument and one request event', () => {
    const env = createOpenEnv({ 'x/1': { a: 1, keep: true } });
    const requests: RequestEvent[] = [];
    const writes: WriteSandboxEvent[] = [];
    env.onRequest((event) => requests.push(event));
    env.onWrite((event) => writes.push(event));

    const result = env.execute({
      method: 'update',
      path: 'x/1',
      auth: null,
      data: { a: 2 },
      merge: { mergeFields: ['b'] },
    });

    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe('invalid-argument');
    expect(result.error?.message).toContain("Field 'b'");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.result).toBe('deny');
    expect(requests[0]?.method).toBe('update');
    expect(requests[0]?.path).toBe('x/1');
    expect(requests[0]?.rulesDisposition).toEqual({
      kind: 'not-evaluated',
      reason: 'runtime-error',
    });
    expect(requests[0]?.request?.merge).toEqual({ mergeFields: ['b'] });
    expect(writes).toHaveLength(0);
    expect(env.getDocument('x/1')).toEqual({ a: 1, keep: true });
  });

  it('LocalEnvironment.execute set and create with missing mergeFields deny with invalid-argument and request event', () => {
    const env = createOpenEnv({ 'x/1': { a: 1 } });
    const requests: RequestEvent[] = [];
    env.onRequest((event) => requests.push(event));

    const setResult = env.execute({
      method: 'set',
      path: 'x/1',
      auth: null,
      data: { a: 2 },
      merge: { mergeFields: ['nested.missing'] },
    });
    expect(setResult.allowed).toBe(false);
    expect(setResult.error?.code).toBe('invalid-argument');
    expect(env.getDocument('x/1')).toEqual({ a: 1 });

    const createResult = env.execute({
      method: 'create',
      path: 'x/new',
      auth: null,
      data: { a: 2 },
      merge: { mergeFields: ['b'] },
    });
    expect(createResult.allowed).toBe(false);
    expect(createResult.error?.code).toBe('invalid-argument');
    expect(env.getDocument('x/new')).toBeNull();

    const emptyDataResult = env.execute({
      method: 'update',
      path: 'x/1',
      auth: null,
      merge: { mergeFields: ['b'] },
    });
    expect(emptyDataResult.allowed).toBe(false);
    expect(emptyDataResult.error?.code).toBe('invalid-argument');

    expect(requests).toHaveLength(3);
    for (const req of requests) {
      expect(req.result).toBe('deny');
      expect(req.rulesDisposition).toEqual({
        kind: 'not-evaluated',
        reason: 'runtime-error',
      });
    }
  });

  it('modular setDoc with missing mergeFields rejects with invalid-argument and records one request event', async () => {
    const sb = initializeSandbox();
    const env = getInternalEnv(sb);
    env.seed({ rules: OPEN_RULES, documents: { 'x/1': { a: 1, keep: true } } });
    const requests: RequestEvent[] = [];
    env.onRequest((event) => requests.push(event));

    const db = getFirestore(sb);
    await expect(
      setDoc(doc(db, 'x/1'), { a: 2 }, { mergeFields: ['b'] }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.result).toBe('deny');
    expect(requests[0]?.path).toBe('x/1');
    expect(requests[0]?.request?.merge).toEqual({ mergeFields: ['b'] });
    expect(env.getDocument('x/1')).toEqual({ a: 1, keep: true });
    sb.dispose();
  });
});
