import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { createServiceWorkerRelay } from '../../../src/serve/worker/service-worker-relay.js';
import type {
  OutboundMessage,
  ResMessage,
} from '../../../src/serve/worker/protocol.js';
import type { ServiceWorkerChannelMessage } from '../../../src/serve/worker/service-worker-channel.js';

describe('Service Worker relay lifecycle', () => {
  it('replaces a restarted realm and removes its stale broker subscriptions', async () => {
    const sandbox = initializeSandbox();
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      instanceId: 'service-worker-relay-test',
      subs: new Map(),
      messagingEnabled: true,
    };
    const sent: ServiceWorkerChannelMessage[] = [];
    const relay = createServiceWorkerRelay({
      getCtx: async () => ctx,
      send(message) { sent.push(message); },
    });
    const attach = (sessionId: string) => relay.handle({
      direction: 'host',
      phase: 'attach',
      clientId: 'service-worker:%5BDEFAULT%5D',
      sessionId,
    });
    const message = (
      value: Parameters<typeof relay.handle>[0] & { direction: 'host'; phase: 'message' },
    ) => relay.handle(value);

    await attach('old-realm');
    await message({
      direction: 'host',
      phase: 'message',
      clientId: 'service-worker:%5BDEFAULT%5D',
      sessionId: 'old-realm',
      message: { t: 'sub', subId: 'sub-1', target: 'messaging.background' },
    });
    await message({
      direction: 'host',
      phase: 'message',
      clientId: 'service-worker:%5BDEFAULT%5D',
      sessionId: 'old-realm',
      message: { t: 'sub', subId: 'sub-2', target: 'messaging.background' },
    });
    expect([...ctx.subs.values()][0]?.size).toBe(2);

    await attach('new-realm');
    expect(ctx.subs.size).toBe(0);
    await message({
      direction: 'host',
      phase: 'message',
      clientId: 'service-worker:%5BDEFAULT%5D',
      sessionId: 'new-realm',
      message: { t: 'sub', subId: 'sub-1', target: 'messaging.background' },
    });
    await message({
      direction: 'host',
      phase: 'message',
      clientId: 'service-worker:%5BDEFAULT%5D',
      sessionId: 'old-realm',
      message: { t: 'sub', subId: 'sub-late', target: 'messaging.background' },
    });

    const driverMessages: OutboundMessage[] = [];
    const driver: PortLike = { postMessage(value) { driverMessages.push(value); } };
    await handleMessage(ctx, driver, {
      t: 'op',
      id: 'deliver-after-restart',
      method: 'messaging.deliver',
      spec: { data: { source: 'restart-test' } },
    });
    const response = driverMessages.find(
      (value): value is ResMessage => value.t === 'res' && value.id === 'deliver-after-restart',
    );
    expect(response?.ok).toBe(true);
    if (!response?.ok) throw new Error('delivery failed');
    expect(response.value).toMatchObject({ route: 'background', handlerCount: 1 });
    expect(sent.filter((value) => value.direction === 'client')).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ sessionId: 'new-realm' });
  });
});
