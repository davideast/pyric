import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'bun:test';
import { createBridge, type Bridge } from '../../src/bridge/server/bridge.js';
import { createConsumerSession } from '../../src/bridge/server/peer.js';
import {
  DOC_VALUE_ENCODING_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
} from '../../src/bridge/protocol.js';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../src/serve/worker/protocol.js';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getFirestore as getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { setDatabaseRules } from '../../src/serve/worker/host/rules.js';

const PERMISSIVE_FIRESTORE_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} {
        allow read, write: if true;
      }
    }
  }
`;

const PERMISSIVE_RTDB_RULES = JSON.stringify({
  rules: {
    '.read': true,
    '.write': true,
  },
});

const REPO_ROOT = resolve(import.meta.dir, '../../../..');

interface TestConsumer {
  send: (msg: BridgeMessage) => void;
  op: (id: string, op: Record<string, unknown>) => Promise<Record<string, unknown>>;
  sub: (subId: string, sub: Record<string, unknown>) => Promise<Record<string, unknown>>;
  unsub: (subId: string) => void;
  close: () => void;
  received: BridgeMessage[];
}

async function createParityHarness(): Promise<{
  bridge: Bridge;
  ctx: HostCtx;
  connectConsumer: (capabilities?: string[]) => TestConsumer;
  teardown: () => void;
}> {
  const sandbox = initializeSandbox();
  getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE_FIRESTORE_RULES);
  await sandbox.enablePersistence({
    key: `native-parity-${Math.random().toString(36).slice(2)}`,
    injectedBackend: createMemoryBackend(),
  });
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'native-parity',
    subs: new Map(),
  };
  setDatabaseRules(ctx, undefined, PERMISSIVE_RTDB_RULES);
  setDatabaseRules(ctx, 'secondary-db', PERMISSIVE_RTDB_RULES);

  const bridge = createBridge({ version: 'test', callTimeoutMs: 5_000 });
  let gen = 0;
  const port: PortLike = {
    postMessage(raw: unknown) {
      const m = raw as OutboundMessage;
      if (m.t === 'res') {
        bridge.handleSandboxMessage(
          m.ok
            ? { type: 'worker-res', id: m.id, ok: true, value: m.value }
            : { type: 'worker-res', id: m.id, ok: false, error: m.error },
          gen,
        );
      } else if (m.t === 'snap') {
        bridge.handleSandboxMessage(
          { type: 'worker-snap', subId: m.subId, value: m.value },
          gen,
        );
      }
    },
  };

  const disconnectPeer = bridge.registerSandboxPeer(
    (msg) => {
      if (gen === 0) gen = bridge.peerGeneration();
      if (msg.type === 'worker-op') {
        void handleMessage(ctx, port, { ...msg.op, t: 'op', id: msg.id } as InboundMessage);
      } else if (msg.type === 'worker-sub') {
        void handleMessage(ctx, port, { ...msg.sub, t: 'sub', subId: msg.subId } as InboundMessage);
      } else if (msg.type === 'worker-unsub') {
        void handleMessage(ctx, port, { t: 'unsub', subId: msg.subId } as InboundMessage);
      }
    },
    [],
    'parity-peer',
    [WORKER_RELAY_CAPABILITY],
  );

  const connectConsumer = (capabilities?: string[]): TestConsumer => {
    const received: BridgeMessage[] = [];
    const resWaiters = new Map<string, (msg: Record<string, unknown>) => void>();
    const snapWaiters = new Map<string, (msg: Record<string, unknown>) => void>();

    const session = createConsumerSession(bridge, (msg) => {
      received.push(msg);
      if (msg.type === 'worker-res') {
        const waiter = resWaiters.get(msg.id);
        if (waiter) {
          resWaiters.delete(msg.id);
          waiter(msg as unknown as Record<string, unknown>);
        }
      } else if (msg.type === 'worker-snap') {
        const waiter = snapWaiters.get(msg.subId);
        if (waiter) {
          snapWaiters.delete(msg.subId);
          waiter(msg as unknown as Record<string, unknown>);
        }
      }
    });

    const attachMsg: BridgeMessage = capabilities
      ? { type: 'attach', protocol: 1, capabilities }
      : { type: 'attach', protocol: 1 };
    session.handleMessage(attachMsg);

    return {
      received,
      send(msg: BridgeMessage) {
        session.handleMessage(msg);
      },
      op(id: string, op: Record<string, unknown>) {
        return new Promise((resolveRes) => {
          resWaiters.set(id, resolveRes);
          session.handleMessage({ type: 'worker-op', id, op } as BridgeMessage);
        });
      },
      sub(subId: string, sub: Record<string, unknown>) {
        return new Promise((resolveSnap) => {
          snapWaiters.set(subId, resolveSnap);
          session.handleMessage({ type: 'worker-sub', subId, sub } as BridgeMessage);
        });
      },
      unsub(subId: string) {
        session.handleMessage({ type: 'worker-unsub', subId } as BridgeMessage);
      },
      close() {
        session.dispose();
      },
    };
  };

  return {
    bridge,
    ctx,
    connectConsumer,
    teardown() {
      disconnectPeer();
    },
  };
}

describe('Native client & Firestore/RTDB wire-protocol parity', () => {
  it('negotiates pyric/firestore-values/1 per consumer across reads and subscriptions', async () => {
    const harness = await createParityHarness();
    const legacy = harness.connectConsumer();
    const v1 = harness.connectConsumer([DOC_VALUE_ENCODING_CAPABILITY]);

    try {
      const adminDb = getAdminFirestore(harness.ctx.sandbox.withAuth(null));
      await adminDb.doc('items/typed').set({ type: 'order', label: 'a', count: 2 });
      await adminDb.doc('items/nav').set({ id: 'home', path: '/home' });
      await adminDb.doc('items/nums').set({ bad: Number.NaN, inf: Number.POSITIVE_INFINITY });

      const legacyTyped = await legacy.op('g1', { method: 'getDoc', path: 'items/typed' });
      expect(legacyTyped.ok).toBe(true);
      const legacyTypedData = (legacyTyped.value as { data: { json: string; valueEncoding?: string } }).data;
      expect(legacyTypedData.valueEncoding).toBeUndefined();
      expect(JSON.parse(legacyTypedData.json)).toEqual({ type: 'order', label: 'a', count: 2 });

      const legacyNav = await legacy.op('g2', { method: 'getDoc', path: 'items/nav' });
      const legacyNavData = (legacyNav.value as { data: { json: string; valueEncoding?: string } }).data;
      expect(legacyNavData.valueEncoding).toBeUndefined();
      expect(JSON.parse(legacyNavData.json)).toEqual({ id: 'home', path: '/home' });

      const legacyNums = await legacy.op('g3', { method: 'getDoc', path: 'items/nums' });
      const legacyNumsData = (legacyNums.value as { data: { json: string; valueEncoding?: string } }).data;
      expect(legacyNumsData.valueEncoding).toBeUndefined();
      expect(JSON.parse(legacyNumsData.json)).toEqual({ bad: null, inf: null });

      const legacySub = await legacy.sub('s-legacy', {
        target: { __ref: 'doc', path: 'items/typed' },
      });
      const legacySnapData = (legacySub.value as { data: { json: string; valueEncoding?: string } }).data;
      expect(legacySnapData.valueEncoding).toBeUndefined();
      expect(JSON.parse(legacySnapData.json)).toEqual({ type: 'order', label: 'a', count: 2 });
      legacy.unsub('s-legacy');

      const v1Typed = await v1.op('v1-g1', { method: 'getDoc', path: 'items/typed' });
      const v1TypedData = (v1Typed.value as { data: { json: string; valueEncoding?: string } }).data;
      expect(v1TypedData.valueEncoding).toBe(DOC_VALUE_ENCODING_CAPABILITY);
      expect(JSON.parse(v1TypedData.json)).toEqual({
        type: 'pyric/map/1.0',
        fields: { type: 'order', label: 'a', count: 2 },
      });

      const v1Nums = await v1.op('v1-g2', { method: 'getDoc', path: 'items/nums' });
      const v1NumsData = (v1Nums.value as { data: { json: string; valueEncoding?: string } }).data;
      expect(v1NumsData.valueEncoding).toBe(DOC_VALUE_ENCODING_CAPABILITY);
      expect(JSON.parse(v1NumsData.json)).toEqual({
        bad: { __type: 'number', value: 'NaN' },
        inf: { __type: 'number', value: 'Infinity' },
      });

      const legacyDocs = await legacy.op('g4', {
        method: 'getDocs',
        source: { __ref: 'collection', path: 'items' },
      });
      const legacyDocsList = (legacyDocs.value as { docs: Array<{ data: { valueEncoding?: string } }> }).docs;
      expect(legacyDocsList.length).toBeGreaterThanOrEqual(3);
      for (const entry of legacyDocsList) {
        expect(entry.data.valueEncoding).toBeUndefined();
      }

      const v1Sub = await v1.sub('s-v1', {
        target: { __ref: 'doc', path: 'items/typed' },
      });
      const v1SnapData = (v1Sub.value as { data: { json: string; valueEncoding?: string } }).data;
      expect(v1SnapData.valueEncoding).toBe(DOC_VALUE_ENCODING_CAPABILITY);
      v1.unsub('s-v1');

      const v1Docs = await v1.op('v1-g3', {
        method: 'getDocs',
        source: { __ref: 'collection', path: 'items' },
      });
      const v1DocsList = (v1Docs.value as { docs: Array<{ data: { valueEncoding?: string } }> }).docs;
      expect(v1DocsList.length).toBeGreaterThanOrEqual(3);
      for (const entry of v1DocsList) {
        expect(entry.data.valueEncoding).toBe(DOC_VALUE_ENCODING_CAPABILITY);
      }
    } finally {
      legacy.close();
      v1.close();
      harness.teardown();
    }
  });

  it('rejects malformed setDoc, batchCommit, and txnCommit payloads and accepts canonical forms', async () => {
    const harness = await createParityHarness();
    const client = harness.connectConsumer([DOC_VALUE_ENCODING_CAPABILITY]);

    try {
      const seed = await client.op('w0', {
        method: 'setDoc',
        path: 'items/doc1',
        data: { keep: 'yes', count: 1 },
      });
      expect(seed.ok).toBe(true);

      const badTopLevelMerge = await client.op('w1', {
        method: 'setDoc',
        path: 'items/doc1',
        data: { count: 2 },
        merge: true,
      });
      expect(badTopLevelMerge.ok).toBe(false);
      expect((badTopLevelMerge.error as { code: string }).code).toBe('invalid-argument');

      const goodMerge = await client.op('w2', {
        method: 'setDoc',
        path: 'items/doc1',
        data: { count: 2 },
        options: { merge: true },
      });
      expect(goodMerge.ok).toBe(true);

      const goodMergeFields = await client.op('w3', {
        method: 'setDoc',
        path: 'items/doc1',
        data: { count: 4, ignored: 'nope' },
        options: { mergeFields: ['count'] },
      });
      expect(goodMergeFields.ok).toBe(true);

      const afterMerge = await client.op('r1', { method: 'getDoc', path: 'items/doc1' });
      const afterMergeData = JSON.parse(
        (afterMerge.value as { data: { json: string } }).data.json,
      ) as Record<string, unknown>;
      expect(afterMergeData).toEqual({ keep: 'yes', count: 4 });

      const badBatchOp = await client.op('b1', {
        method: 'batchCommit',
        writes: [{ op: 'set', path: 'items/doc1', data: { count: 3 }, merge: true }],
      });
      expect(badBatchOp.ok).toBe(false);
      expect((badBatchOp.error as { code: string }).code).toBe('invalid-argument');

      const goodBatch = await client.op('b2', {
        method: 'batchCommit',
        writes: [
          { method: 'set', path: 'items/doc1', data: { extra: 'ok' }, options: { merge: true } },
        ],
      });
      expect(goodBatch.ok).toBe(true);

      const badTxnMissingRead = await client.op('t1', {
        method: 'txnCommit',
        reads: [{ path: 'items/missing', data: { json: 'null' } }],
        writes: [{ method: 'set', path: 'items/missing', data: { created: true } }],
      });
      expect(badTxnMissingRead.ok).toBe(false);
      expect((badTxnMissingRead.error as { code: string }).code).toBe('invalid-argument');

      const goodTxnMissingRead = await client.op('t2', {
        method: 'txnCommit',
        reads: [{ path: 'items/missing', data: null }],
        writes: [{ method: 'set', path: 'items/missing', data: { created: true } }],
      });
      expect(goodTxnMissingRead.ok).toBe(true);
    } finally {
      client.close();
      harness.teardown();
    }
  });

  it('canonicalizes plain map key order during txnCommit conflict checks', async () => {
    const harness = await createParityHarness();
    const client = harness.connectConsumer([DOC_VALUE_ENCODING_CAPABILITY]);

    try {
      await client.op('s1', {
        method: 'setDoc',
        path: 'items/map-order',
        data: { alpha: 1, nested: { first: 'x', second: 'y' }, zeta: 2 },
      });

      const reorderedCommit = await client.op('t-reordered', {
        method: 'txnCommit',
        reads: [
          {
            path: 'items/map-order',
            data: {
              json: JSON.stringify({ zeta: 2, nested: { second: 'y', first: 'x' }, alpha: 1 }),
            },
          },
        ],
        writes: [
          {
            method: 'update',
            path: 'items/map-order',
            data: { alpha: 99 },
          },
        ],
      });
      expect(reorderedCommit.ok).toBe(true);

      const staleCommit = await client.op('t-stale', {
        method: 'txnCommit',
        reads: [
          {
            path: 'items/map-order',
            data: {
              json: JSON.stringify({ zeta: 2, nested: { second: 'y', first: 'x' }, alpha: 1 }),
            },
          },
        ],
        writes: [{ method: 'update', path: 'items/map-order', data: { alpha: 100 } }],
      });
      expect(staleCommit.ok).toBe(false);
      expect((staleCommit.error as { code: string }).code).toBe('aborted');
    } finally {
      client.close();
      harness.teardown();
    }
  });

  it('accepts canonical and compat vectors while failing closed on unknown sentinels', async () => {
    const harness = await createParityHarness();
    const client = harness.connectConsumer([DOC_VALUE_ENCODING_CAPABILITY]);

    try {
      const canonicalRes = await client.op('v1', {
        method: 'setDoc',
        path: 'items/vec-canonical',
        data: {
          emb: { type: 'firestore/vectorValue/1.0', vectorValues: [0.1, 0.2] },
          keep: 1,
        },
      });
      expect(canonicalRes.ok).toBe(true);
      const readCanonical = await client.op('r-v1', {
        method: 'getDoc',
        path: 'items/vec-canonical',
      });
      expect(JSON.parse((readCanonical.value as { data: { json: string } }).data.json)).toEqual({
        emb: { type: 'firestore/vectorValue/1.0', vectorValues: [0.1, 0.2] },
        keep: 1,
      });

      const compatRes = await client.op('v2', {
        method: 'setDoc',
        path: 'items/vec-compat',
        data: {
          emb: { __sentinel: 'vector', values: [0.3, 0.4] },
          keep: 2,
        },
      });
      expect(compatRes.ok).toBe(true);
      const readCompat = await client.op('r-v2', {
        method: 'getDoc',
        path: 'items/vec-compat',
      });
      expect(JSON.parse((readCompat.value as { data: { json: string } }).data.json)).toEqual({
        emb: { type: 'firestore/vectorValue/1.0', vectorValues: [0.3, 0.4] },
        keep: 2,
      });

      const unknownSentinel = await client.op('v3', {
        method: 'setDoc',
        path: 'items/bad-sentinel',
        data: {
          field: { __sentinel: 'unsupportedTransform', value: 1 },
        },
      });
      expect(unknownSentinel.ok).toBe(false);
      expect((unknownSentinel.error as { code: string }).code).toBe('invalid-argument');

      const badVectorSentinel = await client.op('v4', {
        method: 'setDoc',
        path: 'items/bad-vector',
        data: {
          emb: { __sentinel: 'vector', values: ['not-a-number'] },
        },
      });
      expect(badVectorSentinel.ok).toBe(false);
      expect((badVectorSentinel.error as { code: string }).code).toBe('invalid-argument');

      const nonArrayVectorSentinel = await client.op('v5', {
        method: 'setDoc',
        path: 'items/bad-vector-non-array',
        data: {
          emb: { __sentinel: 'vector', values: 'not-an-array' },
        },
      });
      expect(nonArrayVectorSentinel.ok).toBe(false);
      expect((nonArrayVectorSentinel.error as { code: string }).code).toBe('invalid-argument');

      const nonFiniteVectorSentinel = await client.op('v6', {
        method: 'setDoc',
        path: 'items/bad-vector-non-finite',
        valueEncoding: 'pyric/firestore-values/1',
        data: {
          emb: {
            __sentinel: 'vector',
            values: [0.1, { __type: 'number', value: 'NaN' }, { __type: 'number', value: 'Infinity' }],
          },
        },
      });
      expect(nonFiniteVectorSentinel.ok).toBe(false);
      expect((nonFiniteVectorSentinel.error as { code: string }).code).toBe('invalid-argument');
    } finally {
      client.close();
      harness.teardown();
    }
  });

  it('isolates RTDB ops and subscriptions by wire instance name', async () => {
    const harness = await createParityHarness();
    const client = harness.connectConsumer([DOC_VALUE_ENCODING_CAPABILITY]);

    try {
      const writeDefault = await client.op('rtdb-w1', {
        method: 'rtdb.set',
        path: '/items/flag',
        value: 'default-val',
      });
      expect(writeDefault.ok).toBe(true);

      const writeSecondary = await client.op('rtdb-w2', {
        method: 'rtdb.set',
        path: '/items/flag',
        value: 'secondary-val',
        instance: 'secondary-db',
      });
      expect(writeSecondary.ok).toBe(true);

      const readDefault = await client.op('rtdb-r1', {
        method: 'rtdb.get',
        path: '/items/flag',
      });
      expect((readDefault.value as { value: unknown }).value).toBe('default-val');

      const readSecondary = await client.op('rtdb-r2', {
        method: 'rtdb.get',
        path: '/items/flag',
        instance: 'secondary-db',
      });
      expect((readSecondary.value as { value: unknown }).value).toBe('secondary-val');

      const subSecondary = await client.sub('rtdb-sub-sec', {
        target: { service: 'rtdb', path: '/items/flag', instance: 'secondary-db' },
      });
      expect((subSecondary.value as { value: unknown }).value).toBe('secondary-val');
      client.unsub('rtdb-sub-sec');
    } finally {
      client.close();
      harness.teardown();
    }
  });

  it('keeps native client wire emitters and decoders aligned with the host protocol', () => {
    const readRepoFile = (relPath: string): string =>
      readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

    const flutterBridge = readRepoFile('packages/flutter-client/lib/src/transport/bridge_client.dart');
    const flutterCodec = readRepoFile('packages/flutter-client/lib/src/transport/codecs.dart');
    const flutterDb = readRepoFile('packages/flutter-client/lib/src/database/pyric_database.dart');

    expect(flutterBridge).toContain('pyric/firestore-values/1');
    expect(flutterCodec).toContain('pyric/map/1.0');
    expect(flutterCodec).toContain("'number'");
    expect(flutterDb).toContain("'instance'");

    const ktBridge = readRepoFile('packages/kt-client/src/main/kotlin/dev/pyric/bridge/BridgeProtocol.kt');
    const ktCodec = readRepoFile('packages/kt-client/src/main/kotlin/dev/pyric/codecs/ValueCodec.kt');
    const ktDocRef = readRepoFile(
      'packages/kt-client/src/main/kotlin/com/google/firebase/firestore/DocumentReference.kt',
    );
    const ktBatch = readRepoFile(
      'packages/kt-client/src/main/kotlin/com/google/firebase/firestore/WriteBatch.kt',
    );
    const ktTxn = readRepoFile(
      'packages/kt-client/src/main/kotlin/com/google/firebase/firestore/Transaction.kt',
    );
    const ktDb = readRepoFile('packages/kt-client/src/main/kotlin/dev/pyric/database/FirebaseDatabase.kt');

    expect(ktBridge).toContain('pyric/firestore-values/1');
    expect(ktCodec).toContain('pyric/map/1.0');
    expect(ktDocRef).toContain('toWireOptions()');
    expect(ktDocRef).not.toContain('"merge" to true');
    expect(ktBatch).toContain('"method" to "set"');
    expect(ktBatch).not.toContain('"op" to');
    expect(ktTxn).toContain('"method" to "set"');
    expect(ktTxn).not.toContain('"op" to');
    expect(ktTxn).not.toContain('"json" to "null"');
    expect(ktDb).toContain('"instance"');

    const swiftFrames = readRepoFile(
      'packages/swift-client/Sources/PyricFirestore/Transport/BridgeWireFrames.swift',
    );
    const swiftCodec = readRepoFile(
      'packages/swift-client/Sources/PyricFirestore/Codecs/ValueCodec.swift',
    );
    const swiftSentinels = readRepoFile(
      'packages/swift-client/Sources/PyricFirestore/Codecs/Sentinels.swift',
    );
    const swiftDb = readRepoFile('packages/swift-client/Sources/PyricDatabase/Database.swift');
    const swiftQuery = readRepoFile('packages/swift-client/Sources/PyricDatabase/DatabaseQuery.swift');

    expect(swiftFrames).toContain('defaultCapabilities');
    expect(swiftCodec).toContain('pyric/firestore-values/1');
    expect(swiftCodec).toContain('pyric/map/1.0');
    expect(swiftCodec).toContain('firestore/vectorValue/1.0');
    expect(swiftSentinels).toContain('firestore/vectorValue/1.0');
    expect(swiftSentinels).not.toContain('"__sentinel": "vector"');
    expect(swiftDb).toContain('"instance"');
    expect(swiftQuery).toContain('targetDict["instance"]');
  });
});
