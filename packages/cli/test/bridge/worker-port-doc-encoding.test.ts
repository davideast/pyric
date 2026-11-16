import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import { getFirestore as getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { createConsumerSession } from '../../src/bridge/server/peer.js';
import {
  DOC_VALUE_ENCODING_CAPABILITY,
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
} from '../../src/bridge/protocol.js';
import { handleMessage, type HostCtx, type PortLike } from '../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../src/serve/worker/protocol.js';

const PERMISSIVE_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} {
        allow read, write: if true;
      }
    }
  }
`;

async function createWorkerPortHarness() {
  const sandbox = initializeSandbox();
  getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE_RULES);
  await sandbox.enablePersistence({
    key: `worker-port-encoding-${Math.random().toString(36).slice(2)}`,
    injectedBackend: createMemoryBackend(),
  });
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'worker-port-encoding',
    subs: new Map(),
  };

  await setDoc(doc(ctx.db, 'items/typed'), {
    type: 'order',
    score: Number.NaN,
    nav: { id: 'home', path: '/home' },
  });

  const bridge = createBridge({ version: 'test', callTimeoutMs: 5_000 });
  const ports = new Map<string, PortLike>();
  let gen = 0;

  const portFor = (clientSessionId: string): PortLike => {
    const existing = ports.get(clientSessionId);
    if (existing) return existing;
    const port: PortLike = {
      postMessage(raw: unknown) {
        const message = raw as OutboundMessage;
        bridge.handleSandboxMessage(
          { type: 'worker-message-result', clientSessionId, message },
          gen,
        );
      },
    };
    ports.set(clientSessionId, port);
    return port;
  };

  const disconnectPeer = bridge.registerSandboxPeer(
    (msg) => {
      if (gen === 0) gen = bridge.peerGeneration();
      if (msg.type === 'worker-message' && msg.clientSessionId) {
        void handleMessage(ctx, portFor(msg.clientSessionId), msg.message as InboundMessage);
      }
    },
    [],
    'worker-port-peer',
    [WORKER_RELAY_CAPABILITY, WORKER_PORT_CAPABILITY],
  );

  const attachWorkerPort = (capabilities?: string[]) => {
    const resWaiters = new Map<string, (message: OutboundMessage) => void>();
    const snapWaiters = new Map<string, (message: OutboundMessage) => void>();
    const session = createConsumerSession(bridge, (out: BridgeMessage) => {
      if (out.type !== 'worker-message-result') return;
      const m = out.message;
      if (m.t === 'res') {
        const w = resWaiters.get(m.id);
        if (w) {
          resWaiters.delete(m.id);
          w(m);
        }
      } else if (m.t === 'snap') {
        const w = snapWaiters.get(m.subId);
        if (w) {
          snapWaiters.delete(m.subId);
          w(m);
        }
      }
    });

    session.handleMessage(
      capabilities
        ? { type: 'attach', protocol: 1, transport: 'worker-port', capabilities }
        : { type: 'attach', protocol: 1, transport: 'worker-port' },
    );

    const sendOp = (message: InboundMessage & { t: 'op' }) =>
      new Promise<OutboundMessage>((resolve) => {
        resWaiters.set(message.id, resolve);
        session.handleMessage({ type: 'worker-message', message });
      });

    const sendSub = (message: InboundMessage & { t: 'sub' }) =>
      new Promise<OutboundMessage>((resolve) => {
        snapWaiters.set(message.subId, resolve);
        session.handleMessage({ type: 'worker-message', message });
      });

    return {
      sendOp,
      sendSub,
      unsub(subId: string) {
        session.handleMessage({ type: 'worker-message', message: { t: 'unsub', subId } });
      },
      close() {
        session.dispose();
      },
    };
  };

  return {
    attachWorkerPort,
    teardown() {
      disconnectPeer();
    },
  };
}

describe('worker-port consumer Firestore docValueEncoding gating', () => {
  it('enforces legacy encoding for unnegotiated worker-port consumers and blocks spoofing', async () => {
    const harness = await createWorkerPortHarness();
    const legacy = harness.attachWorkerPort();
    const negotiated = harness.attachWorkerPort([DOC_VALUE_ENCODING_CAPABILITY]);

    try {
      const legacyRead = await legacy.sendOp({
        t: 'op',
        id: 'wp-1',
        method: 'getDoc',
        path: 'items/typed',
      });
      expect(legacyRead.t).toBe('res');
      if (legacyRead.t !== 'res' || !legacyRead.ok) throw new Error('expected ok res');
      const legacyData = (legacyRead.value as { data: { json: string; valueEncoding?: string } }).data;
      expect(legacyData.valueEncoding).toBeUndefined();
      expect(JSON.parse(legacyData.json)).toEqual({
        type: 'order',
        score: null,
        nav: { id: 'home', path: '/home' },
      });

      // Spoofed docValueEncoding on op is overwritten by the bridge to legacy.
      const spoofedOp = await legacy.sendOp({
        t: 'op',
        id: 'wp-2',
        method: 'getDoc',
        path: 'items/typed',
        docValueEncoding: DOC_VALUE_ENCODING_CAPABILITY,
      });
      expect(spoofedOp.t).toBe('res');
      if (spoofedOp.t !== 'res' || !spoofedOp.ok) throw new Error('expected ok res');
      const spoofedOpData = (spoofedOp.value as { data: { json: string; valueEncoding?: string } }).data;
      expect(spoofedOpData.valueEncoding).toBeUndefined();
      expect(JSON.parse(spoofedOpData.json)).toEqual({
        type: 'order',
        score: null,
        nav: { id: 'home', path: '/home' },
      });

      // Spoofed docValueEncoding on Firestore sub is overwritten by the bridge to legacy.
      const spoofedSub = await legacy.sendSub({
        t: 'sub',
        subId: 'wp-sub-1',
        target: { __ref: 'doc', path: 'items/typed' },
        docValueEncoding: DOC_VALUE_ENCODING_CAPABILITY,
      });
      expect(spoofedSub.t).toBe('snap');
      if (spoofedSub.t !== 'snap') throw new Error('expected snap');
      const spoofedSubData = (spoofedSub.value as { data: { json: string; valueEncoding?: string } }).data;
      expect(spoofedSubData.valueEncoding).toBeUndefined();
      expect(JSON.parse(spoofedSubData.json)).toEqual({
        type: 'order',
        score: null,
        nav: { id: 'home', path: '/home' },
      });
      legacy.unsub('wp-sub-1');

      // Negotiated worker-port consumer receives lossless v1 encoding on op and sub.
      const v1Read = await negotiated.sendOp({
        t: 'op',
        id: 'wp-3',
        method: 'getDoc',
        path: 'items/typed',
      });
      expect(v1Read.t).toBe('res');
      if (v1Read.t !== 'res' || !v1Read.ok) throw new Error('expected ok res');
      const v1Data = (v1Read.value as { data: { json: string; valueEncoding?: string } }).data;
      expect(v1Data.valueEncoding).toBe(DOC_VALUE_ENCODING_CAPABILITY);
      expect(JSON.parse(v1Data.json)).toEqual({
        type: 'pyric/map/1.0',
        fields: {
          type: 'order',
          score: { __type: 'number', value: 'NaN' },
          nav: { type: 'pyric/map/1.0', fields: { id: 'home', path: '/home' } },
        },
      });

      const v1Sub = await negotiated.sendSub({
        t: 'sub',
        subId: 'wp-sub-2',
        target: { __ref: 'doc', path: 'items/typed' },
      });
      expect(v1Sub.t).toBe('snap');
      if (v1Sub.t !== 'snap') throw new Error('expected snap');
      const v1SubData = (v1Sub.value as { data: { json: string; valueEncoding?: string } }).data;
      expect(v1SubData.valueEncoding).toBe(DOC_VALUE_ENCODING_CAPABILITY);
      negotiated.unsub('wp-sub-2');
    } finally {
      legacy.close();
      negotiated.close();
      harness.teardown();
    }
  });
});
