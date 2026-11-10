import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { mintIdToken } from 'pyric/sandbox/internal';
import { IdBindings, matchRecorded, normalize, TIME } from '../../src/serve/repro/compare.js';
import { cloneReproValue, parseRepro } from '../../src/serve/repro/format.js';
import { createReproRecorder } from '../../src/serve/repro/recorder.js';
import { buildReproFile, captureReproBase } from '../../src/serve/repro/capture.js';
import { replayRepro } from '../../src/serve/repro/replay.js';
import { runServeReproCapture, runServeReproReplay } from '../../src/cli/serve-repro.js';
import { handleMessage, type HostCtx, type PortLike } from '../../src/serve/worker/host.js';
import { initializeSandbox } from 'pyric/sandbox';
import { captureCheckpoint } from 'pyric/sandbox/checkpoints';
import { getFirestore } from 'pyric/firestore';
import { getAdminDatabase, ref, set } from 'pyric/database';
import { getStorageSandbox } from 'pyric/storage';
import { installStorageBackend, type StorageBackend } from 'pyric/storage/internal';
import { rtdbInstance } from '../../src/serve/worker/host/rtdb-instances.js';
import type { ReproBase } from '../../src/serve/repro/format.js';
import type { InboundMessage, OutboundMessage } from '../../src/serve/worker/protocol.js';
import { bytesToBase64 } from '../../src/serve/worker/protocol.js';
import { parseArgs } from '../../src/cli/parse-args.js';

const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
const signed = `${encode({ alg: 'RS256', kid: 'k1' })}.${encode({ sub: 'alice', iat: 1, admin: true })}.c2lnbmF0dXJlLWJ5dGVz`;

describe('repro value fidelity and prototype safety', () => {
  test('cloneReproValue keeps signed JWTs, PEM strings, and service-account objects verbatim', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n';
    const input = {
      customToken: signed,
      nested: [signed],
      pem: key,
      privateKey: 'abc',
      account: { type: 'service_account', client_email: 'a@b', private_key: key },
    };
    const cloned = cloneReproValue(input);
    expect(cloned).toEqual(input);
    expect(JSON.stringify(cloned)).toContain('c2lnbmF0dXJlLWJ5dGVz');
    expect(JSON.stringify(cloned)).not.toContain('__redactedJwt');
  });

  test('cloneReproValue preserves __proto__ as an own property without mutating prototypes', () => {
    const payload = JSON.parse('{"__proto__":{"toString":"not-callable","role":"member"},"title":"ok"}') as Record<string, unknown>;
    const cloned = cloneReproValue(payload) as Record<string, unknown>;
    expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype);
    expect(() => String(cloned)).not.toThrow();
    expect(Object.prototype.hasOwnProperty.call(cloned, '__proto__')).toBe(true);
    expect(Object.keys(cloned).sort()).toEqual(['__proto__', 'title']);
  });

  test('a signed JWT in Storage customMetadata round-trips verbatim through buildReproFile and replays', async () => {
    const storageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /assertions/{name} {
      allow read: if resource.metadata.assertion == '${signed}';
      allow write: if request.resource.metadata.assertion == '${signed}';
    }
  }
}`;
    const sandbox = initializeSandbox();
    getStorageSandbox(sandbox, {
      dbName: `pyric-repro-storage-jwt-${crypto.randomUUID()}`,
      rules: storageRules,
    });
    try {
      const startingSandbox = initializeSandbox();
      const emptyCheckpoint = await captureCheckpoint(startingSandbox);
      startingSandbox.dispose();
      const ctx: HostCtx = { db: getFirestore(sandbox), sandbox, instanceId: 'repro-storage-jwt', subs: new Map() };
      const recorder = createReproRecorder({
        capture: async () => ({
          ...base(),
          checkpoint: emptyCheckpoint,
          rules: { firestore: null, database: {}, storage: storageRules },
        }),
      });
      const sendOp = async (id: string, payload: Record<string, unknown>): Promise<OutboundMessage> => {
        const inbound = { t: 'op', id, ...payload } as InboundMessage;
        await recorder.inbound('tab-storage', inbound);
        const reply = await new Promise<OutboundMessage>((resolve) => {
          const port: PortLike = {
            postMessage(msg: OutboundMessage) {
              recorder.outbound('tab-storage', msg);
              if (msg.t === 'res' && msg.id === id) resolve(msg);
            },
          };
          void handleMessage(ctx, port, inbound);
        });
        return reply;
      };

      const uploaded = await sendOp('up-1', {
        method: 'storage.putBytes',
        path: 'assertions/claim.json',
        dataB64: bytesToBase64(new TextEncoder().encode('{"ok":true}')),
        metadata: {
          contentType: 'application/json',
          customMetadata: { assertion: signed, owner: 'alice@example.com' },
        },
      });
      expect(uploaded.t === 'res' && uploaded.ok).toBe(true);

      const fetched = await sendOp('meta-1', {
        method: 'storage.getMetadata',
        path: 'assertions/claim.json',
      });
      expect(fetched.t === 'res' && fetched.ok).toBe(true);

      const repro = await buildReproFile(await recorder.log(), () => undefined);
      const serialized = JSON.stringify(repro);
      expect(serialized).toContain(signed);
      expect(serialized).toContain('c2lnbmF0dXJlLWJ5dGVz');
      expect(serialized).not.toContain('__redactedJwt');

      const parsed = parseRepro(JSON.parse(serialized));
      const report = await replayRepro(parsed, { planes: ['worker'] });
      expect(report.ok).toBe(true);
      expect(report.planes.worker?.checked).toBe(2);
    } finally {
      sandbox.dispose();
    }
  });
});

describe('repro comparison', () => {
  test('a generated id is bound once and later frames use the replayed id', () => {
    const bindings = new IdBindings();
    const recorded = { user: { uid: 'anonymous-0a1b2c3d4e5f6a7b8c9d' } };
    const replayed = { user: { uid: 'anonymous-9f8e7d6c5b4a3f2e1d0c' } };
    expect(matchRecorded(recorded, replayed, bindings).matches).toBe(true);
    expect(bindings.toReplay({ path: 'users/anonymous-0a1b2c3d4e5f6a7b8c9d/name' }))
      .toEqual({ path: 'users/anonymous-9f8e7d6c5b4a3f2e1d0c/name' });
  });

  test('a push key is bound from the one object key each side holds alone', () => {
    const bindings = new IdBindings();
    const recorded = { value: { seeded: { by: 'seed' }, '-OAbcdEFGhij0123456': { by: 'a' } } };
    const replayed = { value: { seeded: { by: 'seed' }, '-OZyxwVUTsrq9876543': { by: 'a' } } };
    expect(matchRecorded(recorded, replayed, bindings).matches).toBe(true);
  });

  test('a changed word is a divergence, not a binding', () => {
    const bindings = new IdBindings();
    expect(matchRecorded({ value: 'first' }, { value: 'second' }, bindings).matches).toBe(false);
    expect(matchRecorded({ name: 'b' }, { name: 'corrupted' }, bindings).matches).toBe(false);
  });

  test('a recorded id bound to two replayed ids is a divergence', () => {
    const bindings = new IdBindings();
    expect(matchRecorded({ id: 'AbCdEfGhIjKlMnOpQr12' }, { id: 'ZyXwVuTsRqPoNmLkJi98' }, bindings).matches).toBe(true);
    expect(matchRecorded({ id: 'AbCdEfGhIjKlMnOpQr12' }, { id: 'QqQqQqQqQqQqQqQqQq77' }, bindings).matches).toBe(false);
  });

  test('times compare equal to times', () => {
    expect(normalize({ at: 1_760_000_000_000, ts: { seconds: 1, nanoseconds: 2 }, iso: '2026-10-08T12:00:00.000Z', iat: 5 }))
      .toEqual({ at: TIME, iat: TIME, iso: TIME, ts: TIME });
    expect(normalize('{"createdAt":1760000000000}')).toEqual({ json: { createdAt: TIME } });
  });

  test('a sandbox ID token minted a second later matches: its time claims compare as times', () => {
    const minted = (at: number) => `sandbox-id-token-u1-1:${JSON.stringify({ sub: 'u1', auth_time: at, iat: at, exp: at + 3600, user_id: 'u1' })}`;
    expect(matchRecorded({ value: minted(1_793_196_457) }, { value: minted(1_793_196_458) }, new IdBindings()).matches).toBe(true);
    const otherSubject = minted(1_793_196_457).replace('"sub":"u1"', '"sub":"u2"');
    expect(matchRecorded({ value: minted(1_793_196_457) }, { value: otherSubject }, new IdBindings()).matches).toBe(false);
  });

  test('a raw JWT ID token minted a second later matches as the replay compares it: claims kept, times as times, tag ignored (#1836)', () => {
    const minted = (at: number, sub = 'u1') => mintIdToken({ sub, auth_time: at, iat: at, exp: at + 3600, user_id: sub, name: 'Builder One' }, 1);
    const recorded = { value: minted(1_793_196_457) };
    expect(matchRecorded(recorded, { value: minted(1_793_196_458) }, new IdBindings()).matches).toBe(true);
    expect(matchRecorded(recorded, { value: minted(1_793_196_457, 'u2') }, new IdBindings()).matches).toBe(false);

    const anonBindings = new IdBindings();
    anonBindings.bind('anonymous-0a1b2c3d4e5f6a7b8c9d', 'anonymous-9f8e7d6c5b4a3f2e1d0c');
    expect(matchRecorded(
      { value: minted(1_793_196_457, 'anonymous-0a1b2c3d4e5f6a7b8c9d') },
      { value: minted(1_793_196_459, 'anonymous-9f8e7d6c5b4a3f2e1d0c') },
      anonBindings,
    ).matches).toBe(true);
  });
});

function base(): Omit<ReproBase, 'subscriptions'> {
  return {
    at: 0,
    checkpoint: { format: 'pyric-checkpoint-v1', at: 0, counts: { firestore: 0, database: 0, storage: 0, auth: 0 }, state: {} } as never,
    databaseInstances: {}, rules: { firestore: null, database: {}, storage: null },
    defaultInstance: '(default)', permissive: false, appOptions: null, sessions: {},
  };
}

describe('repro recorder', () => {
  test('a full window opens a new one with the listeners still open, and drops the window before it', async () => {
    let captures = 0;
    const recorder = createReproRecorder({ limit: 2, capture: async () => { captures++; return base(); } });
    const op = (id: string) => ({ t: 'op', id, method: 'rtdb.get', path: 'a' }) as InboundMessage;
    await recorder.inbound('tab', { t: 'sub', subId: 's1', target: { service: 'rtdb', path: 'a' } } as InboundMessage);
    await recorder.inbound('tab', op('1'));
    await recorder.inbound('tab', op('2'));
    await recorder.inbound('tab', { t: 'unsub', subId: 's1' } as InboundMessage);
    await recorder.inbound('tab', op('3'));
    const log = await recorder.log();
    expect(captures).toBe(3);
    expect(log.truncated).toBe(true);
    expect(log.entries.map((entry) => entry.kind === 'in' ? entry.frame.t : '')).toEqual(['op', 'unsub', 'op']);
    expect(log.base.subscriptions.tab?.map((frame) => frame.t === 'sub' ? frame.subId : '')).toEqual(['s1']);
  });

  test('Studio event streams and clock frames are not recorded', async () => {
    const recorder = createReproRecorder({ capture: async () => base() });
    await recorder.inbound('studio', { t: 'sub', subId: 'e', target: 'events' } as InboundMessage);
    await recorder.inbound('studio', { t: 'clock-subscribe' } as InboundMessage);
    expect((await recorder.log()).entries).toEqual([]);
  });

  test('an observed call is recorded without its claim values, write data or returned document', async () => {
    const recorder = createReproRecorder({ capture: async () => base() });
    const call = {
      service: 'firestore', method: 'setDoc', at: 1, outcome: { status: 'ok' }, path: 'rooms/a',
      account: { uid: 'alice', claimNames: ['admin'], claims: { admin: true } },
      writeData: { title: 'Lobby' },
      document: { title: 'Hall' },
    };
    await recorder.inbound('tab', { t: 'observe', id: 'o1', call } as InboundMessage);
    const [entry] = (await recorder.log()).entries;
    const frame = entry?.kind === 'in' ? entry.frame : undefined;
    expect(frame).toEqual({
      t: 'observe', id: 'o1',
      call: { service: 'firestore', method: 'setDoc', at: 1, outcome: { status: 'ok' }, path: 'rooms/a', account: { uid: 'alice', claimNames: ['admin'] } },
    } as InboundMessage);
    expect(call.account.claims).toEqual({ admin: true });
  });

  test("an observed call is recorded without production's message, which can quote document data", async () => {
    const recorder = createReproRecorder({ capture: async () => base() });
    const message = 'Function setDoc() called with invalid data. Data must be an object, but it was: "Patient Jane Q Doe"';
    const outcome = { status: 'error', code: 'invalid-argument', message };
    const call = { service: 'firestore', method: 'setDoc', at: 1, outcome, path: 'notes/n1' };
    await recorder.inbound('tab', { t: 'observe', id: 'o1', call } as InboundMessage);
    const [entry] = (await recorder.log()).entries;
    const frame = entry?.kind === 'in' ? entry.frame : undefined;
    expect(frame).toEqual({
      t: 'observe', id: 'o1',
      call: { service: 'firestore', method: 'setDoc', at: 1, outcome: { status: 'error', code: 'invalid-argument' }, path: 'notes/n1' },
    } as InboundMessage);
    expect(JSON.stringify(await recorder.log())).not.toContain('Jane');
    expect(outcome.message).toBe(message);
  });
});

/** A Storage backend with no objects, whose objects a capture by reference can list. */
function emptyReferencedStorage(): StorageBackend {
  const none = async () => undefined;
  return {
    put: none,
    deleteIfGeneration: async () => false,
    replaceIfGeneration: async () => false,
    getBlob: none,
    getMetadata: none,
    getObject: none,
    putMetadata: async () => {},
    delete: async () => {},
    listByPrefix: async () => [],
    reset: async () => {},
    close: () => {},
    references: async () => [],
  };
}

describe('pyric serve repro', () => {
  const output = () => {
    let text = '';
    return { write: (value: string) => { text += value; }, text: () => text };
  };

  test('capture without a running Node host says how to start one', async () => {
    const err = output();
    const code = await runServeReproCapture(parseArgs(['serve', 'repro', 'capture', '--out', `/nonexistent-${Date.now()}/r.json`]), {
      stderr: err, stdout: output(), discover: async () => null,
    });
    expect(code).toBe(2);
    expect(err.text()).toContain('no running Node host found');
  });

  test('capture asks the discovered host instance for its repro and writes it', async () => {
    const { mkdtempSync, readFileSync, realpathSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-repro-cli-')));
    let request: unknown;
    const server = Bun.serve({
      port: 0,
      async fetch(incoming) {
        request = { path: new URL(incoming.url).pathname, body: await incoming.json() };
        return Response.json({ schema: 'pyric.repro.v1', entries: [1, 2, 3], truncated: false });
      },
    });
    try {
      const out = output();
      const code = await runServeReproCapture(parseArgs(['serve', 'repro', 'capture', '--out', 'bug.json']), {
        cwd: directory, stdout: out, stderr: output(),
        discover: async () => ({ base: `http://127.0.0.1:${server.port}`, instanceId: 'host-1', url: '', mcpUrl: '', source: 'test' }),
      });
      expect(code).toBe(0);
      expect(request).toEqual({ path: '/__pyric/hosted/repro', body: { instanceId: 'host-1', projectDir: directory } });
      expect(JSON.parse(readFileSync(join(directory, 'bug.json'), 'utf8')).entries).toEqual([1, 2, 3]);
      expect(out.text()).toContain('Wrote 3 log entries');
    } finally {
      server.stop(true);
    }
  });

  test("capturing the base reads a second RTDB instance's tree without recording a read", async () => {
    const sandbox = initializeSandbox();
    // A host's Storage keeps its objects in files a capture refers to; this one holds none.
    installStorageBackend(sandbox, emptyReferencedStorage());
    try {
      const ctx: HostCtx = { db: getFirestore(sandbox), sandbox, instanceId: 'repro-test', subs: new Map() };
      ctx.defaultRtdbInstance = 'demo-default-rtdb';
      rtdbInstance(ctx, 'demo-default-rtdb');
      rtdbInstance(ctx, 'second-instance');
      await set(ref(getAdminDatabase(sandbox, 'second-instance'), '/items/a'), { count: 1 });
      const before = sandbox.history().length;
      const base = await captureReproBase(ctx, []);
      expect(base.databaseInstances).toMatchObject({ 'second-instance': { items: { a: { count: 1 } } } });
      const recorded = sandbox.history().slice(before);
      expect(recorded.filter((event) => event.service === 'rtdb')).toEqual([]);
    } finally {
      sandbox.dispose();
    }
  });

  test('replay refuses a file that is not a repro', async () => {
    expect(() => parseRepro({ schema: 'pyric.verify.fixture.v1' })).toThrow('Not a pyric.repro.v1 file');
    const err = output();
    const code = await runServeReproReplay(parseArgs(['serve', 'repro', 'replay', 'package.json', '--plane', 'browser']), { stderr: err, stdout: output() });
    expect(code).toBe(2);
    expect(err.text()).toContain("--plane is 'node' or 'worker'");
  });
});

describe('the repro recorder and observed session data', () => {
  test('strips sessionData from inbound observe frames so repro files never carry observed values', async () => {
    const recorder = createReproRecorder({
      capture: async () => ({
        firestore: { rules: null, documents: {} },
        auth: { users: [], currentUserUid: null },
        database: { rules: null, data: null },
        storage: { rules: null, objects: [] },
      }),
    });
    await recorder.inbound('client-1', {
      t: 'observe',
      id: 'obs-1',
      call: {
        service: 'firestore',
        method: 'getDoc',
        path: 'items/doc1',
        at: 10,
        outcome: { status: 'ok' },
        document: { marker: 'should-be-stripped' },
      },
      sessionData: {
        firestore: [{ kind: 'set', path: 'items/doc1', data: { marker: 'should-be-stripped' } }],
      },
    } as InboundMessage);
    const log = JSON.stringify(await recorder.log());
    expect(log).not.toContain('should-be-stripped');
    expect(log).not.toContain('sessionData');
  });
});
