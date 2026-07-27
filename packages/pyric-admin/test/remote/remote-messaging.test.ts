/**
 * `pyric-admin` remote messaging arm — tests that Admin Messaging dispatches
 * send, sendEach, and topic operations over RemoteSandbox through the real
 * bridge and worker host, preserving wire error envelopes.
 */

import { afterEach, describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

import { createBridge, type Bridge } from '../../../cli/src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../cli/src/bridge/server/peer.js';
import {
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
} from '../../../cli/src/bridge/protocol.js';
import {
  createRemoteSandboxCore,
  createRemoteSandboxHandle,
  type RemoteSandbox,
} from '../../../cli/src/remote/index.js';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../cli/src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../../../cli/src/serve/worker/protocol.js';

import { initializeApp, deleteApp, getApps } from '../../src/app/index.js';
import { getMessaging } from '../../src/messaging/index.js';

const SERVE_URL = 'http://localhost:5000';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

function makeWorkerCtx(): HostCtx {
  const sandbox = initializeSandbox();
  return {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'admin-remote-test',
    subs: new Map(),
    messagingEnabled: true,
  };
}

function connectTab(bridge: Bridge, ctx: HostCtx): void {
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
  bridge.registerSandboxPeer(send, [], 'fake-tab', [WORKER_RELAY_CAPABILITY]);
}

function connectRemote(bridge: Bridge): RemoteSandbox {
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
    close: () => core.dispose('remote sandbox connection closed by the client'),
  });
}

let directOpSeq = 0;
function workerOp(ctx: HostCtx, op: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const port: PortLike = {
      postMessage(raw: unknown) {
        const m = raw as OutboundMessage;
        if (m.t !== 'res') return;
        if (m.ok) resolve(m.value);
        else reject(new Error(m.error.message));
      },
    };
    void handleMessage(ctx, port, {
      ...op,
      t: 'op',
      id: `direct-${++directOpSeq}`,
    } as InboundMessage);
  });
}

describe('remote messaging dispatch', () => {
  it('dispatches send to a token minted in the worker broker', async () => {
    const ctx = makeWorkerCtx();
    const bridge = createBridge({ mode: 'sandbox', version: 'test' });
    connectTab(bridge, ctx);
    const remote = connectRemote(bridge);

    // Mint a token directly in the worker
    const { token } = (await workerOp(ctx, {
      method: 'messaging.getToken',
      registrationId: 'client-sw',
    })) as { token: string };

    const app = initializeApp({ sandbox: remote });
    const messaging = getMessaging(app);

    const messageId = await messaging.send({
      token,
      notification: { title: 'Hello Remote' },
    });
    expect(messageId).toMatch(/^projects\/.*\/messages\/.*/);

    remote.dispose();
  });

  it('preserves error envelopes for unregistered tokens over remote channel', async () => {
    const ctx = makeWorkerCtx();
    const bridge = createBridge({ mode: 'sandbox', version: 'test' });
    connectTab(bridge, ctx);
    const remote = connectRemote(bridge);

    const app = initializeApp({ sandbox: remote });
    const messaging = getMessaging(app);

    await expect(
      messaging.send({
        token: 'aaaa:APA91bNEVERMINTED',
        notification: { title: 'Fail' },
      }),
    ).rejects.toThrow('Requested entity was not found.');

    try {
      await messaging.send({
        token: 'aaaa:APA91bNEVERMINTED',
        notification: { title: 'Fail' },
      });
    } catch (err: any) {
      expect(err.code).toBe('messaging/registration-token-not-registered');
      expect(err.message).toBe('Requested entity was not found.');
    }

    remote.dispose();
  });

  it('dispatches subscribeToTopic and unsubscribeFromTopic over remote channel', async () => {
    const ctx = makeWorkerCtx();
    const bridge = createBridge({ mode: 'sandbox', version: 'test' });
    connectTab(bridge, ctx);
    const remote = connectRemote(bridge);

    const { token } = (await workerOp(ctx, {
      method: 'messaging.getToken',
      registrationId: 'client-sw-topic',
    })) as { token: string };

    const app = initializeApp({ sandbox: remote });
    const messaging = getMessaging(app);

    const subRes = await messaging.subscribeToTopic([token], 'news');
    expect(subRes.successCount).toBe(1);
    expect(subRes.failureCount).toBe(0);

    const unsubRes = await messaging.unsubscribeFromTopic([token], 'news');
    expect(unsubRes.successCount).toBe(1);
    expect(unsubRes.failureCount).toBe(0);

    remote.dispose();
  });
});
