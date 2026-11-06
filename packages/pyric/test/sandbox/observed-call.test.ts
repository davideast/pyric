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

const UPLOAD: ObservedCall = {
  service: 'storage',
  method: 'uploadBytes',
  path: 'avatars/alice.png',
  bucket: 'my-project.firebasestorage.app',
  at: 1_700_000_000_000,
  durationMs: 64,
  outcome: { status: 'ok' },
  account: { uid: 'alice' },
  projectId: 'my-project',
};

const GENERATE: ObservedCall = {
  service: 'ai',
  method: 'generateContent',
  at: 1_700_000_000_000,
  durationMs: 120,
  outcome: { status: 'ok' },
  projectId: 'my-project',
  ai: {
    model: 'models/gemini-flash-lite-latest',
    reportedModel: 'gemini-2.5-flash-lite',
    usage: { promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 11 },
  },
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

  it('keeps a Storage call with its bucket and path, and the root reference with no path', () => {
    expect(readObservedCall(UPLOAD)).toEqual(UPLOAD);
    const denied = { ...UPLOAD, method: 'getBytes', bucket: 'my-project-live-second', outcome: { status: 'error', code: 'storage/unauthorized' } };
    expect(readObservedCall(denied)).toEqual(denied as ObservedCall);
    const { path: _path, ...root } = UPLOAD;
    const listRoot = { ...root, method: 'listAll' };
    expect(readObservedCall(listRoot)).toEqual(listRoot as ObservedCall);
  });

  it('refuses a bucket that is not a bare bucket name, or on a call that is not Storage', () => {
    const cases: Array<[unknown, string]> = [
      [{ ...UPLOAD, bucket: undefined }, 'bucket'],
      [{ ...UPLOAD, bucket: 'gs://my-project.firebasestorage.app' }, 'bucket'],
      [{ ...UPLOAD, bucket: 'My-Project' }, 'bucket'],
      [{ ...UPLOAD, bucket: 'ab' }, 'bucket'],
      [{ ...UPLOAD, bucket: '-my-project' }, 'bucket'],
      [{ ...UPLOAD, bucket: 'my-project.' }, 'bucket'],
      [{ ...UPLOAD, bucket: 'my/project' }, 'bucket'],
      [{ ...UPLOAD, bucket: 'a'.repeat(223) }, 'bucket'],
      [{ ...UPLOAD, bucket: 7 }, 'bucket'],
      [{ ...DENIED_READ, bucket: 'my-project.firebasestorage.app' }, 'bucket'],
      [{ ...NAMED_RTDB_READ, bucket: 'my-project.firebasestorage.app' }, 'bucket'],
      [{ ...GENERATE, bucket: 'my-project.firebasestorage.app' }, 'bucket'],
      [{ ...UPLOAD, instance: 'my-project-default-rtdb' }, 'instance'],
    ];
    for (const [record, field] of cases) {
      const read = () => readObservedCall(record);
      expect(read).toThrow(ObservedCallError);
      expect(read).toThrow(`Invalid observed call field: ${field}.`);
    }
    expect(readObservedCall({ ...UPLOAD, bucket: `a${'b'.repeat(220)}c` }).bucket).toHaveLength(222);
  });

  it('keeps an AI call with its model, token counts and first chunk time', () => {
    expect(readObservedCall(GENERATE)).toEqual(GENERATE);
    const stream = { ...GENERATE, method: 'chat.sendMessageStream', ai: { ...GENERATE.ai, firstChunkMs: 40 } };
    expect(readObservedCall(stream)).toEqual(stream as ObservedCall);
    const count = { ...GENERATE, method: 'countTokens', ai: { model: 'models/gemini-flash-lite-latest', usage: { totalTokens: 5 } } };
    expect(readObservedCall(count)).toEqual(count as ObservedCall);
    const refused = { ...GENERATE, outcome: { status: 'error', code: 'unauthenticated' }, ai: { model: 'models/gemini-flash-lite-latest' } };
    expect(readObservedCall(refused)).toEqual(refused as ObservedCall);
  });

  it('refuses an AI field that is not a model name or a token count', () => {
    const cases: Array<[unknown, string]> = [
      [{ ...GENERATE, ai: undefined }, 'ai'],
      [{ ...DENIED_READ, ai: GENERATE.ai }, 'ai'],
      [{ ...NAMED_RTDB_READ, ai: GENERATE.ai }, 'ai'],
      [{ ...GENERATE, ai: 'models/gemini' }, 'ai'],
      [{ ...GENERATE, path: 'models/gemini-flash-lite-latest' }, 'path'],
      [{ ...GENERATE, ai: { ...GENERATE.ai, text: 'Hello' } }, 'ai.text'],
      [{ ...GENERATE, ai: { ...GENERATE.ai, response: { candidates: [] } } }, 'ai.response'],
      [{ ...GENERATE, ai: { ...GENERATE.ai, model: undefined } }, 'ai.model'],
      [{ ...GENERATE, ai: { ...GENERATE.ai, model: '' } }, 'ai.model'],
      [{ ...GENERATE, ai: { ...GENERATE.ai, model: 'models/has space' } }, 'ai.model'],
      [{ ...GENERATE, ai: { ...GENERATE.ai, model: 'm'.repeat(201) } }, 'ai.model'],
      [{ ...GENERATE, ai: { ...GENERATE.ai, reportedModel: 'Say "hi"' } }, 'ai.reportedModel'],
      [{ ...GENERATE, ai: { ...GENERATE.ai, usage: [9, 2, 11] } }, 'ai.usage'],
      [{ ...GENERATE, ai: { ...GENERATE.ai, usage: { promptTokenCount: '9' } } }, 'ai.usage.promptTokenCount'],
      [{ ...GENERATE, ai: { ...GENERATE.ai, usage: { candidatesTokenCount: -1 } } }, 'ai.usage.candidatesTokenCount'],
      [{ ...GENERATE, ai: { ...GENERATE.ai, usage: { totalTokenCount: 1.5 } } }, 'ai.usage.totalTokenCount'],
      [{ ...GENERATE, ai: { ...GENERATE.ai, usage: { totalTokens: Number.MAX_SAFE_INTEGER + 1 } } }, 'ai.usage.totalTokens'],
      [{ ...GENERATE, ai: { ...GENERATE.ai, usage: { thoughtsTokenCount: 4 } } }, 'ai.usage.thoughtsTokenCount'],
      [{ ...GENERATE, ai: { ...GENERATE.ai, firstChunkMs: -1 } }, 'ai.firstChunkMs'],
    ];
    for (const [record, field] of cases) {
      const read = () => readObservedCall(record);
      expect(read).toThrow(ObservedCallError);
      expect(read).toThrow(`Invalid observed call field: ${field}.`);
    }
  });

  it('refuses a malformed record and names the field', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'call'],
      [[DENIED_READ], 'call'],
      [{ ...DENIED_READ, service: 'functions' }, 'service'],
      [{ ...DENIED_READ, instance: 'my-project-default-rtdb' }, 'instance'],
      [{ ...NAMED_RTDB_READ, instance: '' }, 'instance'],
      [{ ...NAMED_RTDB_READ, instance: 'Named' }, 'instance'],
      [{ ...NAMED_RTDB_READ, instance: '-named' }, 'instance'],
      [{ ...NAMED_RTDB_READ, instance: 'named.firebaseio.com' }, 'instance'],
      [{ ...NAMED_RTDB_READ, instance: 'a'.repeat(101) }, 'instance'],
      [{ ...NAMED_RTDB_READ, instance: 7 }, 'instance'],
      [{ ...NAMED_RTDB_READ, instance: undefined }, 'instance'],
      [{ service: 'rtdb', method: 'set', path: '/items/a', at: 1, outcome: { status: 'ok' } }, 'instance'],
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

  it("becomes the AI event the sandbox's own AI calls make, with production's answer and no response", () => {
    const event = observedCallEvent(readObservedCall({ ...GENERATE, ai: { ...GENERATE.ai, firstChunkMs: 40 } }));
    expect(event).toMatchObject({
      kind: 'operation',
      service: 'ai',
      method: 'generateContent',
      path: 'models/gemini-flash-lite-latest',
      result: 'not-applicable',
      durationMs: 120,
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      production: { outcome: { status: 'ok' } },
      observation: {
        id: event.id,
        startedAt: GENERATE.at,
        endedAt: GENERATE.at + 120,
        status: 'completed',
        ai: {
          requestedModel: 'models/gemini-flash-lite-latest',
          reportedModel: 'gemini-2.5-flash-lite',
          engine: 'gemini',
          endpoint: 'https://firebasevertexai.googleapis.com',
          usageSource: 'backend',
          inputTokens: 9,
          outputTokens: 2,
          totalTokens: 11,
          durationMs: 120,
          firstChunkMs: 40,
        },
      },
    });
    expect(event.observation).not.toHaveProperty('response');
  });

  it("counts countTokens' total, and reads a call with no usage as unknown and a refusal as failed", () => {
    const count = observedCallEvent({ ...GENERATE, method: 'countTokens', ai: { model: 'models/m', usage: { totalTokens: 5 } } });
    expect(count.observation?.ai).toMatchObject({ usageSource: 'backend', totalTokens: 5 });
    const refused = observedCallEvent({ ...GENERATE, durationMs: undefined, outcome: { status: 'error', code: 'unauthenticated' }, ai: { model: 'models/m' } });
    expect(refused).toMatchObject({ result: 'error', production: { outcome: { status: 'error', code: 'unauthenticated' } } });
    expect(refused.observation).toMatchObject({ status: 'failed', endedAt: GENERATE.at, error: { code: 'unauthenticated' } });
    expect(refused.observation?.ai).toEqual({ requestedModel: 'models/m', engine: 'gemini', endpoint: 'https://firebasevertexai.googleapis.com', usageSource: 'unknown' });
  });

  it('puts a Storage call\'s bucket on the event as detail.bucket, the key sandbox Storage events use', () => {
    const event = observedCallEvent(readObservedCall(UPLOAD));
    expect(event).toMatchObject({
      kind: 'operation',
      service: 'storage',
      method: 'uploadBytes',
      path: 'avatars/alice.png',
      detail: { bucket: 'my-project.firebasestorage.app' },
      auth: { uid: 'alice' },
      result: 'not-applicable',
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      production: { outcome: { status: 'ok' } },
    });
    expect(event.detail).toEqual({ bucket: 'my-project.firebasestorage.app' });
    expect(observedCallEvent(DENIED_READ)).not.toHaveProperty('detail');
  });

  it('gives a non-AI call no observation', () => {
    expect(observedCallEvent(DENIED_READ)).not.toHaveProperty('observation');
  });

  it("reads production's permission-denied, in any service's spelling, as denied", () => {
    expect(productionVerdict({ status: 'ok' })).toBe('ok');
    expect(productionVerdict({ status: 'error', code: 'permission-denied' })).toBe('denied');
    expect(productionVerdict({ status: 'error', code: 'PERMISSION_DENIED' })).toBe('denied');
    expect(productionVerdict({ status: 'error', code: 'firestore/permission-denied' })).toBe('denied');
    expect(productionVerdict({ status: 'error', code: 'auth/wrong-password' })).toBe('failed');
  });

  it("reads Storage's storage/unauthorized as denied and every other Storage code as failed", () => {
    expect(productionVerdict({ status: 'error', code: 'storage/unauthorized' })).toBe('denied');
    for (const code of ['storage/unauthenticated', 'storage/object-not-found', 'storage/canceled', 'storage/unknown']) {
      expect(productionVerdict({ status: 'error', code })).toBe('failed');
    }
  });

  it("reads Storage's App Check rejection, storage/unauthorized-app, as denied", () => {
    expect(productionVerdict({ status: 'error', code: 'storage/unauthorized-app' })).toBe('denied');
  });

  it('leaves a sandbox-served operation unmarked', () => {
    expect(isProductionServed({ kind: 'evaluated', verdict: 'allow' })).toBe(false);
    expect(isProductionServed({ kind: 'not-evaluated', reason: 'not-a-rules-operation' })).toBe(false);
    expect(isProductionServed(undefined)).toBe(false);
  });
});
