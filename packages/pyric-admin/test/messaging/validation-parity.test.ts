/**
 * Standing `firebase-admin/messaging` validation parity suite.
 *
 * Compares `pyric-admin/messaging` (both local sandbox and remote worker-bridge
 * arms) against installed `firebase-admin/messaging` for client-side and
 * intake validation contracts:
 *   1. `data` map shape and string-only value enforcement (`messaging/invalid-payload`)
 *   2. `dryRun` boolean enforcement across `send`, `sendEach`, and `sendEachForMulticast`
 *   3. Single `/topics/` prefix stripping on send and topic management
 *   4. Registration token type, element, and 1,000-token batch enforcement on
 *      `subscribeToTopic` and `unsubscribeFromTopic`
 *   5. `getMessaging(app)` and `messaging(app)` app handle validation (`TypeError`)
 *   6. Condition grammar whitespace separation and 5-topic limit
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  deleteApp as deleteUpstreamApp,
  getApps as getUpstreamApps,
  initializeApp as initializeUpstreamApp,
} from 'firebase-admin/app';
import { getMessaging as getUpstreamMessaging } from 'firebase-admin/messaging';
import { getFirestore } from 'pyric/firestore';
import { getMessagingBroker } from 'pyric/messaging/internal';
import { initializeSandbox } from 'pyric/sandbox';

import { createBridge, type Bridge } from '../../../cli/src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../cli/src/bridge/server/peer.js';
import { WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../../../cli/src/bridge/protocol.js';
import {
  createRemoteSandboxCore,
  createRemoteSandboxHandle,
  type RemoteSandbox,
} from '../../../cli/src/remote/index.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../cli/src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../cli/src/serve/worker/protocol.js';

import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import {
  FirebaseMessagingError,
  getMessaging,
  messaging,
  type Messaging,
} from '../../src/messaging/index.js';

const SERVE_URL = 'http://localhost:5000';

interface MessagingArm {
  readonly label: 'local' | 'remote';
  create(): {
    svc: Messaging;
    token: string;
    delivered: Array<Record<string, string> | undefined>;
    cleanup: () => Promise<void>;
  };
}

function connectWorkerTab(bridge: Bridge, ctx: HostCtx): void {
  let gen = 0;
  const port: PortLike = {
    postMessage(raw: unknown) {
      const m = raw as OutboundMessage;
      if (m.t === 'res') {
        if (m.ok) {
          bridge.handleSandboxMessage({ type: 'worker-res', id: m.id, ok: true, value: m.value }, gen);
        } else {
          bridge.handleSandboxMessage({ type: 'worker-res', id: m.id, ok: false, error: m.error }, gen);
        }
      } else if (m.t === 'snap') {
        bridge.handleSandboxMessage({ type: 'worker-snap', subId: m.subId, value: m.value }, gen);
      }
    },
  };
  const send = (msg: BridgeMessage): void => {
    if (gen === 0) gen = bridge.peerGeneration();
    if (msg.type === 'worker-op') {
      void handleMessage(ctx, port, { ...msg.op, t: 'op', id: msg.id } as InboundMessage);
    } else if (msg.type === 'worker-sub') {
      void handleMessage(ctx, port, { ...msg.sub, t: 'sub', subId: msg.subId } as InboundMessage);
    } else if (msg.type === 'worker-unsub') {
      void handleMessage(ctx, port, { t: 'unsub', subId: msg.subId } as InboundMessage);
    }
  };
  bridge.registerSandboxPeer(send, [], 'parity-tab', [WORKER_RELAY_CAPABILITY]);
}

function connectRemoteSandbox(bridge: Bridge): RemoteSandbox {
  let handleMsg: (msg: BridgeMessage) => void = () => {};
  const session = createConsumerSession(bridge, (msg) => handleMsg(msg));
  const core = createRemoteSandboxCore(
    { send: (msg) => session.handleMessage(msg) },
    { serveUrl: SERVE_URL },
  );
  handleMsg = core.handleMessage;
  core.start();
  return createRemoteSandboxHandle({
    channel: core.channel,
    serveUrl: SERVE_URL,
    close: () => core.dispose('closed by test'),
  });
}

const ARMS: readonly MessagingArm[] = [
  {
    label: 'local',
    create() {
      const sandbox = initializeSandbox({ projectId: 'demo-project' });
      const app = initializeApp(
        { sandbox, projectId: 'demo-project' },
        `parity-local-${Math.random().toString(36).slice(2)}`,
      );
      const broker = getMessagingBroker(sandbox);
      const token = broker.getTokenFor('reg-local');
      const delivered: Array<Record<string, string> | undefined> = [];
      broker.onBackgroundMessage((payload) => {
        delivered.push(payload.data);
      });
      return {
        svc: getMessaging(app),
        token,
        delivered,
        async cleanup() {
          await deleteApp(app).catch(() => {});
          sandbox.dispose();
        },
      };
    },
  },
  {
    label: 'remote',
    create() {
      const sandbox = initializeSandbox({ projectId: 'demo-project' });
      const ctx: HostCtx = {
        db: getFirestore(sandbox),
        sandbox,
        instanceId: 'parity-remote',
        subs: new Map(),
        messagingEnabled: true,
      };
      const bridge = createBridge({ mode: 'sandbox', version: 'test' });
      connectWorkerTab(bridge, ctx);
      const remote = connectRemoteSandbox(bridge);
      const app = initializeApp(
        { sandbox: remote, projectId: 'demo-project' },
        `parity-remote-${Math.random().toString(36).slice(2)}`,
      );
      const broker = getMessagingBroker(sandbox);
      const token = broker.getTokenFor('reg-remote');
      const delivered: Array<Record<string, string> | undefined> = [];
      broker.onBackgroundMessage((payload) => {
        delivered.push(payload.data);
      });
      return {
        svc: getMessaging(app),
        token,
        delivered,
        async cleanup() {
          await deleteApp(app).catch(() => {});
          remote.dispose();
          sandbox.dispose();
        },
      };
    },
  },
];

async function rejectionCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
      return err.code;
    }
    if (err instanceof Error) return err.name;
    return 'unknown-rejection';
  }
  return 'resolved';
}

function freshUpstreamMessaging() {
  const app = initializeUpstreamApp(
    { projectId: 'demo-project' },
    `upstream-parity-${Math.random().toString(36).slice(2)}`,
  );
  return getUpstreamMessaging(app);
}

afterEach(async () => {
  for (const app of getApps()) await deleteApp(app).catch(() => {});
  for (const app of getUpstreamApps()) await deleteUpstreamApp(app).catch(() => {});
});

describe('getMessaging app handle validation parity', () => {
  it('rejects plain objects, null, and primitives with TypeError like firebase-admin', () => {
    for (const invalidApp of [{}, null, 'not-an-app', 42]) {
      expect(() => getUpstreamMessaging(invalidApp as never)).toThrow(TypeError);
      expect(() => getMessaging(invalidApp as never)).toThrow(TypeError);
      expect(() => messaging(invalidApp as never)).toThrow(TypeError);
    }
  });
});

for (const arm of ARMS) {
  describe(`firebase-admin/messaging validation parity (${arm.label} arm)`, () => {
    it('rejects non-string data values and array/null data with messaging/invalid-payload', async () => {
      const upstream = freshUpstreamMessaging();
      const { svc, token, delivered, cleanup } = arm.create();
      try {
        const invalidPayloads: Array<{ label: string; data: unknown }> = [
          { label: 'number value', data: { count: 42 } },
          { label: 'nested object value', data: { nested: { ok: true } } },
          { label: 'boolean value', data: { active: true } },
          { label: 'array data', data: ['not-a-map'] },
          { label: 'null data', data: null },
        ];

        for (const item of invalidPayloads) {
          const upstreamCode = await rejectionCode(() =>
            upstream.send({ token, data: item.data as never }),
          );
          const pyricCode = await rejectionCode(() =>
            svc.send({ token, data: item.data as never }),
          );
          expect(upstreamCode).toBe('messaging/invalid-payload');
          expect(pyricCode).toBe(upstreamCode);

          const batchUpstream = await upstream.sendEach([{ token, data: item.data as never }]);
          const batchPyric = await svc.sendEach([{ token, data: item.data as never }]);
          expect(batchPyric.successCount).toBe(0);
          expect(batchPyric.failureCount).toBe(1);
          expect(batchPyric.responses[0]?.error).toBeInstanceOf(FirebaseMessagingError);
          expect(batchPyric.responses[0]?.error?.code).toBe(batchUpstream.responses[0]?.error?.code);

          const multiUpstream = await upstream.sendEachForMulticast({
            tokens: [token],
            data: item.data as never,
          });
          const multiPyric = await svc.sendEachForMulticast({
            tokens: [token],
            data: item.data as never,
          });
          expect(multiPyric.successCount).toBe(0);
          expect(multiPyric.failureCount).toBe(1);
          expect(multiPyric.responses[0]?.error?.code).toBe(multiUpstream.responses[0]?.error?.code);
        }

        expect(delivered).toHaveLength(0);
      } finally {
        await cleanup();
      }
    });

    it('rejects non-boolean dryRun across send, sendEach, and sendEachForMulticast with zero deliveries', async () => {
      const upstream = freshUpstreamMessaging();
      const { svc, token, delivered, cleanup } = arm.create();
      try {
        for (const badDryRun of ['true', 'false', 1, 0, {}]) {
          expect(
            await rejectionCode(() => svc.send({ token, data: { k: 'a' } }, badDryRun as never)),
          ).toBe(
            await rejectionCode(() =>
              upstream.send({ token, data: { k: 'a' } }, badDryRun as never),
            ),
          );

          expect(
            await rejectionCode(() =>
              svc.sendEach([{ token, data: { k: 'b' } }], badDryRun as never),
            ),
          ).toBe(
            await rejectionCode(() =>
              upstream.sendEach([{ token, data: { k: 'b' } }], badDryRun as never),
            ),
          );

          expect(
            await rejectionCode(() =>
              svc.sendEachForMulticast({ tokens: [token], data: { k: 'c' } }, badDryRun as never),
            ),
          ).toBe(
            await rejectionCode(() =>
              upstream.sendEachForMulticast(
                { tokens: [token], data: { k: 'c' } },
                badDryRun as never,
              ),
            ),
          );
        }

        expect(
          await rejectionCode(() => svc.sendEachForMulticast(null as never)),
        ).toBe(
          await rejectionCode(() => upstream.sendEachForMulticast(null as never)),
        );

        await svc.send({ token, data: { k: 'dry' } }, true);
        expect(delivered).toHaveLength(0);
      } finally {
        await cleanup();
      }
    });

    it('strips /topics/ at most once on send and rejects double-prefixed topics with messaging/invalid-payload', async () => {
      const upstream = freshUpstreamMessaging();
      const { svc, token, delivered, cleanup } = arm.create();
      try {
        await svc.subscribeToTopic([token], 'alerts');
        await svc.send({ topic: '/topics/alerts', data: { id: 'single-ok' } });
        expect(delivered.map((entry) => entry?.id)).toEqual(['single-ok']);

        for (const badTopic of ['/topics//topics/alerts', '/topics/', 'alerts/sub']) {
          const upstreamCode = await rejectionCode(() =>
            upstream.send({ topic: badTopic, data: { id: 'bad' } }),
          );
          const pyricCode = await rejectionCode(() =>
            svc.send({ topic: badTopic, data: { id: 'bad' } }),
          );
          expect(upstreamCode).toBe('messaging/invalid-payload');
          expect(pyricCode).toBe(upstreamCode);

          const batchRes = await svc.sendEach([{ topic: badTopic, data: { id: 'bad' } }]);
          expect(batchRes.failureCount).toBe(1);
          expect(batchRes.responses[0]?.error?.code).toBe('messaging/invalid-payload');
        }

        expect(delivered).toHaveLength(1);

        expect(
          await rejectionCode(() => svc.subscribeToTopic([token], '/topics//topics/alerts')),
        ).toBe(
          await rejectionCode(() => upstream.subscribeToTopic([token], '/topics//topics/alerts')),
        );
        expect(
          await rejectionCode(() => svc.unsubscribeFromTopic([token], '/topics//topics/alerts')),
        ).toBe(
          await rejectionCode(() =>
            upstream.unsubscribeFromTopic([token], '/topics//topics/alerts'),
          ),
        );
      } finally {
        await cleanup();
      }
    });

    it('rejects empty, non-string, and >1000 token inputs in subscribeToTopic and unsubscribeFromTopic', async () => {
      const upstream = freshUpstreamMessaging();
      const { svc, cleanup } = arm.create();
      try {
        const overLimit = Array.from({ length: 1001 }, (_, i) => `tok-${i}`);
        const invalidTokenInputs: unknown[] = [
          '',
          [],
          [''],
          [123],
          ['tok-1', ''],
          ['tok-1', null],
          null,
          undefined,
          overLimit,
        ];

        for (const input of invalidTokenInputs) {
          const upstreamSub = await rejectionCode(() =>
            upstream.subscribeToTopic(input as never, 'items'),
          );
          const pyricSub = await rejectionCode(() =>
            svc.subscribeToTopic(input as never, 'items'),
          );
          expect(upstreamSub).toBe('messaging/invalid-argument');
          expect(pyricSub).toBe(upstreamSub);

          const upstreamUnsub = await rejectionCode(() =>
            upstream.unsubscribeFromTopic(input as never, 'items'),
          );
          const pyricUnsub = await rejectionCode(() =>
            svc.unsubscribeFromTopic(input as never, 'items'),
          );
          expect(upstreamUnsub).toBe('messaging/invalid-argument');
          expect(pyricUnsub).toBe(upstreamUnsub);
        }

        const atLimit = Array.from({ length: 1000 }, (_, i) => `aaa${i}:APA91bTOKEN${i}`);
        const subAtLimit = await svc.subscribeToTopic(atLimit, 'items');
        expect(subAtLimit.successCount).toBe(1000);
        expect(subAtLimit.failureCount).toBe(0);

        const unsubAtLimit = await svc.unsubscribeFromTopic(atLimit, 'items');
        expect(unsubAtLimit.successCount).toBe(1000);
        expect(unsubAtLimit.failureCount).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it('enforces condition whitespace separation, five-topic maximum, and target exclusivity', async () => {
      const { svc, token, cleanup } = arm.create();
      try {
        const fiveTopics =
          "'t1' in topics && 't2' in topics && 't3' in topics && 't4' in topics && 't5' in topics";
        const sixTopics = `${fiveTopics} && 't6' in topics`;

        const acceptedId = await svc.send({ condition: fiveTopics, data: { k: 'ok' } });
        expect(acceptedId).toMatch(/^projects\/demo-project\/messages\/\d+$/);

        for (const badCondition of [sixTopics, "'alerts'intopics", "'alerts'in topics", "'alerts' intopics"]) {
          const code = await rejectionCode(() => svc.send({ condition: badCondition }));
          expect(code).toBe('messaging/invalid-argument');
        }

        const twoTargetCode = await rejectionCode(() =>
          svc.send({ token, topic: '' } as never),
        );
        expect(twoTargetCode).toBe('messaging/invalid-argument');
      } finally {
        await cleanup();
      }
    });
  });
}
