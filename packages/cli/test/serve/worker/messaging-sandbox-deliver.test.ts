/**
 * Issue #397 — `pyric/messaging`'s `sandbox.deliver(getMessaging(app), spec)`
 * must reach the app's REAL broker on the default SharedWorker path, not just
 * the in-page plane. This exercises the whole seam end to end: a bridged
 * client↔host port pair, the worker-backed messaging handle registered through
 * `registerSandboxDelivery`, and pyric's transport-agnostic `sandbox.deliver`
 * driving it over the `messaging.deliver` op.
 *
 * The visibility contract is the assertion that matters: `visible` → the
 * worker-path `onMessage` subscriber (foreground), `hidden` → the worker-path
 * `onBackgroundMessage` subscriber (background).
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import * as fcm from 'pyric/messaging';
import { registerSandboxDelivery, type DeliverSpec } from 'pyric/messaging/internal';
import type { Messaging, MessagePayload } from 'pyric/messaging';

import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { wirePort } from '../../../src/serve/worker/client/core.js';
import {
  messagingDeliver,
  messagingGetMessaging,
  messagingSubscribe,
} from '../../../src/serve/worker/client/messaging.js';
import type { ClientDb, ClientPort } from '../../../src/serve/worker/client/handles.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

/** A ClientPort whose messages drive a real host, replies routed back in-process. */
function bridgedClient(): { db: ClientDb } {
  const sandbox = initializeSandbox();
  const ctx: HostCtx = {
    sandbox,
    db: getFirestore(sandbox),
    instanceId: 'sandbox-deliver-test',
    subs: new Map(),
    messagingEnabled: true,
  };

  const hostPort: PortLike = {
    postMessage(message: OutboundMessage) {
      clientPort.onmessage?.({ data: message } as MessageEvent<OutboundMessage>);
    },
  };
  const clientPort: ClientPort = {
    onmessage: null,
    postMessage(message: InboundMessage) {
      void handleMessage(ctx, hostPort, message);
    },
  };
  wirePort(clientPort);
  return { db: { app: {} as ClientDb['app'], port: clientPort } };
}

/** The default-path handle: worker-backed + a `sandbox.deliver` transport, as `entries/messaging.ts` builds it. */
function workerHandle(db: ClientDb): Messaging {
  const handle = Object.assign(messagingGetMessaging(db), { app: {} }) as unknown as Messaging;
  registerSandboxDelivery(handle, (spec: DeliverSpec) => messagingDeliver(handle as never, spec));
  return handle;
}

describe('sandbox.deliver over the worker transport (#397)', () => {
  it('visible reaches the worker-path onMessage subscriber', async () => {
    const { db } = bridgedClient();
    const messaging = workerHandle(db);
    const foreground: MessagePayload[] = [];
    messagingSubscribe(messaging as never, 'messaging.foreground', (p) => foreground.push(p));

    const result = await fcm.sandbox.deliver(messaging, {
      visibilityState: 'visible',
      data: { hello: 'fg' },
    });

    expect(result.route).toBe('foreground');
    expect(foreground.length).toBe(1);
    expect(foreground[0]!.data!.hello).toBe('fg');
  });

  it('hidden reaches the worker-path onBackgroundMessage subscriber', async () => {
    const { db } = bridgedClient();
    const messaging = workerHandle(db);
    const foreground: MessagePayload[] = [];
    const background: MessagePayload[] = [];
    messagingSubscribe(messaging as never, 'messaging.foreground', (p) => foreground.push(p));
    messagingSubscribe(messaging as never, 'messaging.background', (p) => background.push(p));

    const result = await fcm.sandbox.deliver(messaging, {
      visibilityState: 'hidden',
      notification: { title: 'bg' },
    });

    expect(result.route).toBe('background');
    expect(foreground.length).toBe(0);
    expect(background.length).toBe(1);
    expect(background[0]!.notification!.title).toBe('bg');
  });
});
