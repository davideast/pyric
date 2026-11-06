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

const GET_TOKEN: ObservedCall = {
  service: 'messaging',
  method: 'getToken',
  at: 1_700_000_000_000,
  durationMs: 210,
  outcome: { status: 'ok' },
  account: { uid: 'alice' },
  projectId: 'my-project',
  requests: [
    { api: 'installations', action: 'create', status: 200 },
    { api: 'registrations', action: 'create', status: 200 },
  ],
};

/** An Admin SDK call a backend made, as the live register records it: the class and method, and production's code. */
const ADMIN_UPDATE: ObservedCall = {
  service: 'firestore',
  method: 'DocumentReference.update',
  path: 'rooms/missing',
  at: 1_700_000_000_000,
  durationMs: 18,
  outcome: { status: 'error', code: 'not-found' },
  projectId: 'my-project',
  sdk: 'admin',
};

/** Shapes a recorder must never pass on: a FIS auth token, an FCM registration token, a VAPID key. */
const FIS_AUTH_TOKEN = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJhcHBJZCI6IjE6MTIzNDU2Nzg5MDp3ZWI6YWJjIn0.c2ln';
const FCM_TOKEN = 'dGVzdEZpZDAxMjM0NTY3:APA91bH7xVb0nU3sKq9Yw2Zr5tLp8mQe4cJd6fGh1iOa';
const VAPID_KEY = 'BDd3_hVL9fZi9Ybo2UUzA284WG5FZR30_95YeZJsiApwXKpNcF1rRPF3foIiBHXRdJI2Qhumhf6_LFTeZaNndIo';

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

  it('keeps a Messaging call with the requests it made, and one recorded without them', () => {
    expect(readObservedCall(GET_TOKEN)).toEqual(GET_TOKEN);
    const denied = {
      ...GET_TOKEN,
      outcome: { status: 'error', code: 'permission_denied' },
      requests: [
        { api: 'installations', action: 'generateAuthToken', status: 200 },
        { api: 'registrations', action: 'update', status: 200 },
        { api: 'registrations', action: 'delete' },
        { api: 'registrations', action: 'create', status: 403 },
      ],
    };
    expect(readObservedCall(denied)).toEqual(denied as ObservedCall);
    const { requests: _requests, ...unobserved } = GET_TOKEN;
    const deleteToken = { ...unobserved, method: 'deleteToken' };
    expect(readObservedCall(deleteToken)).toEqual(deleteToken as ObservedCall);
  });

  it('refuses requests on a call that is not Messaging, past four, or with an unknown api, action or status', () => {
    const entry = { api: 'installations', action: 'create', status: 200 };
    const cases: Array<[unknown, string]> = [
      [{ ...DENIED_READ, requests: GET_TOKEN.requests }, 'requests'],
      [{ ...NAMED_RTDB_READ, requests: [] }, 'requests'],
      [{ ...GENERATE, requests: GET_TOKEN.requests }, 'requests'],
      [{ ...GET_TOKEN, requests: [entry, entry, entry, entry, entry] }, 'requests'],
      [{ ...GET_TOKEN, requests: entry }, 'requests'],
      [{ ...GET_TOKEN, requests: [null] }, 'requests'],
      [{ ...GET_TOKEN, requests: [{ ...entry, api: 'fcm' }] }, 'requests.api'],
      [{ ...GET_TOKEN, requests: [{ ...entry, action: 'subscribe' }] }, 'requests.action'],
      [{ ...GET_TOKEN, requests: [{ ...entry, action: 'update' }] }, 'requests.action'],
      [{ ...GET_TOKEN, requests: [{ api: 'registrations', action: 'generateAuthToken' }] }, 'requests.action'],
      [{ ...GET_TOKEN, requests: [{ ...entry, status: 0 }] }, 'requests.status'],
      [{ ...GET_TOKEN, requests: [{ ...entry, status: 600 }] }, 'requests.status'],
      [{ ...GET_TOKEN, requests: [{ ...entry, status: 200.5 }] }, 'requests.status'],
      [{ ...GET_TOKEN, requests: [{ ...entry, status: '200' }] }, 'requests.status'],
      [{ ...GET_TOKEN, requests: [{ ...entry, url: 'https://firebaseinstallations.googleapis.com/v1/projects/my-project/installations' }] }, 'requests.url'],
      [{ ...GET_TOKEN, path: 'registrations' }, 'path'],
    ];
    for (const [record, field] of cases) {
      const read = () => readObservedCall(record);
      expect(read).toThrow(ObservedCallError);
      expect(read).toThrow(`Invalid observed call field: ${field}.`);
    }
  });

  it('refuses a token-shaped string anywhere in a Messaging call', () => {
    const entry = { api: 'registrations', action: 'create', status: 200 };
    const cases: Array<[unknown, string]> = [];
    for (const token of [FIS_AUTH_TOKEN, FCM_TOKEN, VAPID_KEY]) {
      cases.push(
        [{ ...GET_TOKEN, requests: [{ ...entry, token }] }, 'requests.token'],
        [{ ...GET_TOKEN, requests: [{ ...entry, action: token }] }, 'requests.action'],
        [{ ...GET_TOKEN, outcome: { status: 'error', code: token } }, 'outcome.code'],
        [{ ...GET_TOKEN, account: { uid: 'alice', claimNames: ['admin', token] } }, 'account.claimNames'],
        [{ ...GET_TOKEN, token }, 'token'],
      );
    }
    cases.push([{ ...GET_TOKEN, method: VAPID_KEY.slice(0, 64).replace(/[-_]/g, 'a') }, 'method']);
    const cyclic: Record<string, unknown> = { api: 'registrations', action: 'create' };
    cyclic.self = cyclic;
    cases.push([{ ...GET_TOKEN, requests: [cyclic] }, 'requests.self.self']);
    for (const [record, field] of cases) {
      const read = () => readObservedCall(record);
      expect(read).toThrow(ObservedCallError);
      expect(read).toThrow(`Invalid observed call field: ${field}.`);
    }
    // A Firebase Auth uid and the SDK's own codes are not token-shaped.
    const signedIn = { ...GET_TOKEN, account: { uid: 'kX9aQ2bLm4Rt7Yw1Zp0Vc3Ns8Hd2' }, outcome: { status: 'error', code: 'messaging/token-subscribe-failed' } };
    expect(readObservedCall(signedIn)).toEqual(signedIn as ObservedCall);
  });

  it("leaves the account's uid to its own bounds, so a long hex uid keeps its Messaging rows", () => {
    const hexUid = { ...GET_TOKEN, account: { uid: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' } };
    expect(readObservedCall(hexUid)).toEqual(hexUid as ObservedCall);
    expect(() => readObservedCall({ ...GET_TOKEN, account: { uid: 'a'.repeat(129) } })).toThrow('Invalid observed call field: account.uid.');
  });

  it('refuses an oversized string, list or object on a Messaging call in under 50 ms', () => {
    const entry = { api: 'registrations', action: 'create', status: 200 };
    const wideObject = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [`k${index}`, 1]));
    const cases: Array<[unknown, string]> = [
      [{ ...GET_TOKEN, outcome: { status: 'error', code: 'a'.repeat(1_000_000) } }, 'outcome.code'],
      [{ ...GET_TOKEN, method: `${'a'.repeat(500_000)}:${'b'.repeat(500_000)}` }, 'method'],
      [{ ...GET_TOKEN, requests: [{ ...entry, action: 'a'.repeat(1_000_000) }] }, 'requests.action'],
      [{ ...GET_TOKEN, requests: Array.from({ length: 100_000 }, () => entry) }, 'requests'],
      [{ ...GET_TOKEN, requests: [{ ...entry, ...wideObject }] }, 'requests'],
      [{ ...GET_TOKEN, account: { uid: 'alice', claimNames: Array.from({ length: 100_000 }, () => 'a') } }, 'account.claimNames'],
    ];
    for (const [record, field] of cases) {
      const started = performance.now();
      expect(() => readObservedCall(record)).toThrow(`Invalid observed call field: ${field}.`);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });

  it("keeps production's sizes: every usage count and the billed documents", () => {
    const usage = { documentReads: 3, documentWrites: 1, documentDeletes: 2, payloadBytes: 640, uploadedBytes: 0, downloadedBytes: 2048, unmeasured: 1 };
    const read = { service: 'firestore', method: 'getDocs', path: 'rooms', at: 1, outcome: { status: 'ok' }, usage, billedDocuments: 3 };
    const kept = readObservedCall(read);
    expect(kept).toEqual(read as ObservedCall);
    expect(kept.usage).not.toBe(usage);
    const partial = { service: 'storage', method: 'getBytes', path: 'a.bin', bucket: 'b.firebasestorage.app', at: 1, outcome: { status: 'ok' }, usage: { downloadedBytes: 9 } };
    expect(readObservedCall(partial)).toEqual(partial as ObservedCall);
  });

  it('refuses a usage count that is negative, fractional, not a number or unknown', () => {
    const cases: Array<[unknown, string]> = [
      [{ ...DENIED_READ, usage: null }, 'usage'],
      [{ ...DENIED_READ, usage: [3] }, 'usage'],
      [{ ...DENIED_READ, usage: 3 }, 'usage'],
      [{ ...DENIED_READ, usage: { documentReads: -1 } }, 'usage.documentReads'],
      [{ ...DENIED_READ, usage: { documentWrites: 1.5 } }, 'usage.documentWrites'],
      [{ ...DENIED_READ, usage: { payloadBytes: '640' } }, 'usage.payloadBytes'],
      [{ ...DENIED_READ, usage: { downloadedBytes: Number.POSITIVE_INFINITY } }, 'usage.downloadedBytes'],
      [{ ...DENIED_READ, usage: { uploadedBytes: Number.MAX_SAFE_INTEGER + 1 } }, 'usage.uploadedBytes'],
      [{ ...DENIED_READ, usage: { unmeasured: Number.NaN } }, 'usage.unmeasured'],
      [{ ...DENIED_READ, usage: { aiInputTokens: 4 } }, 'usage.aiInputTokens'],
      [{ ...DENIED_READ, usage: { documentReads: 1, value: 'secret' } }, 'usage.value'],
    ];
    for (const [record, field] of cases) {
      const read = () => readObservedCall(record);
      expect(read).toThrow(ObservedCallError);
      expect(read).toThrow(`Invalid observed call field: ${field}.`);
    }
  });

  it('keeps claim values, write data and a returned document, for the host to evaluate in memory', () => {
    const write: ObservedCall = {
      service: 'firestore',
      method: 'setDoc',
      path: 'rooms/r1',
      at: 1,
      outcome: { status: 'ok' },
      account: { uid: 'alice', claimNames: ['admin', 'tier'], claims: { admin: true, tier: { level: 2, tags: ['a', null] } } },
      writeData: { owner: 'alice', count: 3 },
    };
    expect(readObservedCall(write)).toEqual(write);
    const read: ObservedCall = { ...DENIED_READ, outcome: { status: 'ok' }, document: { owner: 'alice', public: false } };
    expect(readObservedCall(read)).toEqual(read);
  });

  it('drops an oversized or malformed value and keeps the rest of the call', () => {
    const big = { text: 'a'.repeat(300_000) };
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 30; level += 1) deep = { next: deep };
    const values: unknown[] = [big, deep, 'not an object', [1, 2], null, { at: Number.NaN }, { fn: () => 1 }, { when: new Date(0) }];
    for (const value of values) {
      const record = { ...DENIED_READ, account: { uid: 'alice', claims: value }, writeData: value, document: value };
      expect(readObservedCall(record)).toEqual({ ...DENIED_READ, account: { uid: 'alice' } });
    }
  });

  it('keeps write data and a document off every call but Firestore, and claim values off Messaging', () => {
    const rtdb = { ...NAMED_RTDB_READ, writeData: { a: 1 }, document: { a: 1 } };
    expect(readObservedCall(rtdb)).toEqual(NAMED_RTDB_READ);
    const firebase = { identities: { 'google.com': ['1234'] }, sign_in_provider: 'google.com' };
    const messaging = { service: 'messaging', method: 'getToken', at: 1, outcome: { status: 'ok' }, account: { uid: 'alice', claims: { firebase } } };
    expect(readObservedCall(messaging)).toEqual({ ...messaging, account: { uid: 'alice' } } as ObservedCall);
  });

  it('leaves claim values, write data and the document off the event', () => {
    const call = readObservedCall({
      ...DENIED_READ,
      account: { uid: 'alice', claimNames: ['admin'], claims: { admin: true } },
      writeData: { owner: 'alice' },
      document: { owner: 'alice' },
    });
    const event = observedCallEvent(call);
    expect(event.production).toEqual({ outcome: DENIED_READ.outcome, claimNames: ['admin'] });
    expect(event).not.toHaveProperty('writeData');
    expect(event).not.toHaveProperty('document');
    expect(event.auth).toEqual({ uid: 'alice' });
  });

  it('keeps an Admin call on Firestore, RTDB, Storage and Auth', () => {
    expect(readObservedCall(ADMIN_UPDATE)).toEqual(ADMIN_UPDATE);
    const admin = [
      { ...NAMED_RTDB_READ, method: 'Reference.set', sdk: 'admin' },
      { ...UPLOAD, method: 'File.save', sdk: 'admin' },
      { service: 'auth', method: 'Auth.verifyIdToken', at: 1, outcome: { status: 'ok' }, account: { uid: 'alice', claimNames: ['admin'] }, sdk: 'admin' },
    ];
    for (const call of admin) expect(readObservedCall(call)).toEqual(call as ObservedCall);
    expect(readObservedCall(DENIED_READ)).not.toHaveProperty('sdk');
  });

  it('refuses sdk on an AI or Messaging call, and any value but admin', () => {
    const cases: unknown[] = [
      { ...GENERATE, sdk: 'admin' },
      { ...GET_TOKEN, sdk: 'admin' },
      { ...ADMIN_UPDATE, sdk: 'client' },
      { ...ADMIN_UPDATE, sdk: true },
      { ...ADMIN_UPDATE, sdk: null },
    ];
    for (const record of cases) {
      const read = () => readObservedCall(record);
      expect(read).toThrow(ObservedCallError);
      expect(read).toThrow('Invalid observed call field: sdk.');
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
      result: 'deny',
      caller: { kind: 'node' },
      production: { outcome: { status: 'error', code: 'permission-denied' }, claimNames: ['admin', 'email'] },
    });
    const record = toOperationRecord(event!);
    expect(record?.result).toBe('deny');
    expect(record?.rules).toEqual({ kind: 'not-evaluated', reason: 'external-execution' });
    expect(record?.production).toEqual({ outcome: { status: 'error', code: 'permission-denied' }, claimNames: ['admin', 'email'] });
    expect(isProductionServed(record?.rules)).toBe(true);
  });

  it('lands an Admin call in the event stream as production-served, bypassing rules under the Admin lens', () => {
    const sandbox = initializeSandbox();
    const hostProvenance = { actor: { kind: 'app' }, authLens: { mode: 'app-session' }, caller: { kind: 'node' } } as const;
    emitSandboxEvent(sandbox, observedCallEvent(readObservedCall(ADMIN_UPDATE)), hostProvenance);
    const [event] = sandbox.history();
    expect(event).toMatchObject({
      kind: 'operation',
      service: 'firestore',
      method: 'DocumentReference.update',
      path: 'rooms/missing',
      auth: null,
      result: 'error',
      origin: 'user',
      caller: { kind: 'node' },
      authLens: { mode: 'admin' },
      detail: { sdk: 'admin' },
      rulesDisposition: { kind: 'bypassed', reason: 'admin' },
      production: { outcome: { status: 'error', code: 'not-found' } },
    });
    const record = toOperationRecord(event!);
    expect(record?.rules).toEqual({ kind: 'bypassed', reason: 'admin' });
    expect(isProductionServed(record?.rules)).toBe(true);
  });

  it("keeps a Storage Admin call's bucket beside its sdk, and leaves a client call without either Admin mark", () => {
    const event = observedCallEvent(readObservedCall({ ...UPLOAD, method: 'File.save', sdk: 'admin' }));
    expect(event.detail).toEqual({ bucket: 'my-project.firebasestorage.app', sdk: 'admin' });
    expect(observedCallEvent(UPLOAD).detail).toEqual({ bucket: 'my-project.firebasestorage.app' });
    expect(observedCallEvent(UPLOAD)).not.toHaveProperty('authLens');
  });

  it("reads production's answer as allow, deny or error, the way sandbox events read", () => {
    const answers: Array<[ObservedCall['outcome'], string]> = [
      [{ status: 'ok' }, 'allow'],
      [{ status: 'error', code: 'permission-denied' }, 'deny'],
      [{ status: 'error', code: 'PERMISSION_DENIED' }, 'deny'],
      [{ status: 'error', code: 'storage/unauthorized' }, 'deny'],
      [{ status: 'error', code: 'unavailable' }, 'error'],
    ];
    for (const [outcome, result] of answers) {
      const event = observedCallEvent({ ...DENIED_READ, outcome });
      expect(event.result).toBe(result);
      expect(event.rulesDisposition).toEqual({ kind: 'not-evaluated', reason: 'external-execution' });
    }
  });

  it("copies production's usage and billed documents onto the event's production side", () => {
    const usage = { documentReads: 3, payloadBytes: 640, unmeasured: 1 };
    const call = readObservedCall({ service: 'firestore', method: 'onSnapshot', path: 'rooms', at: 1, outcome: { status: 'ok' }, usage, billedDocuments: 3 });
    const event = observedCallEvent(call);
    expect(event.production).toEqual({ outcome: { status: 'ok' }, usage, billedDocuments: 3 });
    expect(event.production?.usage).not.toBe(call.usage);
    const zero = observedCallEvent({ service: 'firestore', method: 'onSnapshot', at: 1, outcome: { status: 'ok' }, billedDocuments: 0 });
    expect(zero.production).toEqual({ outcome: { status: 'ok' }, billedDocuments: 0 });
    expect(observedCallEvent(DENIED_READ).production).not.toHaveProperty('usage');
    expect(observedCallEvent(DENIED_READ).production).not.toHaveProperty('billedDocuments');
  });

  it('records a success as allowed and a signed-out call with no account', () => {
    const event = observedCallEvent({ service: 'auth', method: 'signInAnonymously', at: 5, outcome: { status: 'ok' } });
    expect(event.result).toBe('allow');
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
      result: 'allow',
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
      result: 'allow',
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      production: { outcome: { status: 'ok' } },
    });
    expect(event.detail).toEqual({ bucket: 'my-project.firebasestorage.app' });
    expect(observedCallEvent(DENIED_READ)).not.toHaveProperty('detail');
  });

  it("puts a Messaging call's requests on the event as detail.requests, with no path", () => {
    const event = observedCallEvent(readObservedCall(GET_TOKEN));
    expect(event).toMatchObject({
      kind: 'operation',
      service: 'messaging',
      method: 'getToken',
      auth: { uid: 'alice' },
      result: 'allow',
      durationMs: 210,
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      production: { outcome: { status: 'ok' } },
    });
    expect(event.detail).toEqual({ requests: GET_TOKEN.requests });
    expect(event.detail?.requests).not.toBe(GET_TOKEN.requests);
    expect(event).not.toHaveProperty('path');
    const { requests: _requests, ...unobserved } = GET_TOKEN;
    expect(observedCallEvent(unobserved)).not.toHaveProperty('detail');
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

  it("reads a Messaging call's permission_denied as denied and its other codes as failed", () => {
    expect(productionVerdict({ status: 'error', code: 'permission_denied' })).toBe('denied');
    for (const code of ['unauthenticated', 'invalid_argument', 'messaging/token-subscribe-failed', 'installations/request-failed']) {
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
