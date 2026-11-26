import { describe, expect, it } from 'bun:test';
import { getFirestore } from 'pyric/firestore';
import { BrokerSendError, FID_SHAPE_RE, getMessagingBroker } from 'pyric/messaging/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { wirePort } from '../../../src/serve/worker/client/core.js';
import type { ClientDb, ClientPort } from '../../../src/serve/worker/client/handles.js';
import {
  messagingDeleteToken,
  messagingGetMessaging,
  messagingGetToken,
} from '../../../src/serve/worker/client/messaging.js';
import {
  messagingOnRegistered,
  messagingOnUnregistered,
  messagingRegister,
  messagingUnregister,
} from '../../../src/serve/worker/client/messaging-registration.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

function createBridgedHost() {
  const sandbox = initializeSandbox();
  const ctx: HostCtx = {
    sandbox,
    db: getFirestore(sandbox),
    instanceId: 'messaging-reg-worker-test',
    subs: new Map(),
    messagingEnabled: true,
  };

  function connectPort(): ClientDb {
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
    return { app: {} as ClientDb['app'], port: clientPort };
  }

  return { sandbox, ctx, connectPort };
}

describe('SharedWorker Messaging registration parity (#1673)', () => {
  it('delivers FID registration and unregistration across page and service-worker ports and supports scope switching', async () => {
    const { sandbox, connectPort } = createBridgedHost();
    const scopeResolver = async (scope = '/') => `reg-scope:${scope}`;
    const pageMessaging = messagingGetMessaging(connectPort(), scopeResolver);
    const swMessaging = messagingGetMessaging(connectPort(), scopeResolver);

    // Rejects with messaging/invalid-on-registered-handler before onRegistered is attached on pageMessaging.
    const swSeen: string[] = [];
    const unsubSwReg = messagingOnRegistered(swMessaging, (fid) => swSeen.push(fid));
    await expect(messagingRegister(pageMessaging)).rejects.toMatchObject({
      code: 'messaging/invalid-on-registered-handler',
    });

    const pageSeen: string[] = [];
    const pageUnreg: string[] = [];
    const swUnreg: string[] = [];
    const unsubPage1 = messagingOnRegistered(pageMessaging, () => {
      pageSeen.push('stale');
    });
    const unsubPage2 = messagingOnRegistered(pageMessaging, (fid) => {
      pageSeen.push(fid);
    });
    // Stale unsubscribe must not clear the replacement handler.
    unsubPage1();

    messagingOnUnregistered(pageMessaging, (fid) => pageUnreg.push(fid));
    messagingOnUnregistered(swMessaging, {
      next: (fid) => swUnreg.push(fid),
      error: () => {},
      complete: () => {},
    });

    await messagingRegister(pageMessaging);
    expect(pageSeen).toHaveLength(1);
    const fid = pageSeen[0] ?? '';
    expect(FID_SHAPE_RE.test(fid)).toBe(true);
    expect(swSeen).toEqual([fid]);

    // Send plane accepts the FID registered over the worker.
    expect(() => getMessagingBroker(sandbox).send({ token: fid, data: { ping: '1' } })).not.toThrow();

    // Unregister notifies both page and SW ports and marks FID unregistered on the broker.
    await messagingUnregister(pageMessaging);
    expect(pageUnreg).toEqual([fid]);
    expect(swUnreg).toEqual([fid]);
    expect(() => getMessagingBroker(sandbox).send({ token: fid, data: { ping: '2' } })).toThrow(
      BrokerSendError,
    );

    // Custom serviceWorkerRegistration retargets subscriptions and mints a scope-specific FID.
    await messagingRegister(pageMessaging, {
      vapidKey: 'vapid-custom',
      serviceWorkerRegistration: { scope: '/push-v2' } as unknown as ServiceWorkerRegistration,
    });
    expect(pageSeen).toHaveLength(2);
    const scopedFid = pageSeen[1] ?? '';
    expect(scopedFid).not.toBe(fid);

    // deleteToken() after register() revokes the scoped FID and triggers onUnregistered.
    expect(await messagingDeleteToken(pageMessaging)).toBe(true);
    expect(pageUnreg).toEqual([fid, scopedFid]);

    // Legacy getToken() -> deleteToken() does not trigger onUnregistered.
    await messagingGetToken(pageMessaging);
    expect(await messagingDeleteToken(pageMessaging)).toBe(true);
    expect(pageUnreg).toEqual([fid, scopedFid]);

    unsubPage2();
    unsubSwReg();
    sandbox.dispose();
  });
});
