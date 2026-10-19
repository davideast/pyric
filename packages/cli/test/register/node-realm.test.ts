/**
 * When the Node host client keeps its process alive (#1082): while a request
 * waits for its reply or a data subscription is open, and for RTDB from its
 * first call until goOffline() or the app's deletion, as `@firebase/database`
 * does in Node. Auth state subscriptions and finished requests hold nothing.
 */
import { describe, expect, it } from 'bun:test';
import { createNodeSocketRealm } from '../../src/register/client/node-realm.js';
import { rawRpc, wirePort } from '../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../src/serve/worker/client/handles.js';
import type { InboundMessage } from '../../src/serve/worker/protocol.js';

function fakePort(): ClientPort & { sent: InboundMessage[] } {
  const sent: InboundMessage[] = [];
  return { sent, onmessage: null, postMessage(message) { sent.push(message); }, start() {}, close() {} };
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('Node socket realm', () => {
  it('holds while a request waits for its reply and releases after it', async () => {
    const realm = createNodeSocketRealm();
    const port = fakePort();
    port.postMessage = (message) => { port.sent.push(message); realm.traffic(port, { sent: message }); };
    wirePort(port);
    const reply = rawRpc(port, { t: 'op', id: 'unused', method: 'auth.getCurrentUser' } as InboundMessage);
    await settle();
    expect(realm.holdsProcess()).toBe(true);
    const request = port.sent.find(message => message.t === 'op') as { id: string };
    port.onmessage?.(new MessageEvent('message', { data: { t: 'res', id: request.id, ok: true, value: null } }));
    realm.traffic(port, {});
    await reply;
    await settle();
    expect(realm.holdsProcess()).toBe(false);
  });

  it('holds from the first RTDB call on an instance until goOffline', async () => {
    const realm = createNodeSocketRealm();
    const port = fakePort();
    realm.traffic(port, { sent: { t: 'op', id: 'a', method: 'rtdb.set', instance: undefined, path: 'x', value: 1 } as InboundMessage });
    await settle();
    expect(realm.holdsProcess()).toBe(true);
    realm.traffic(port, { sent: { t: 'op', id: 'b', method: 'rtdb.goOffline', instance: undefined } as InboundMessage });
    await settle();
    expect(realm.holdsProcess()).toBe(false);
  });

  it('releases RTDB when the app connection closes', async () => {
    const realm = createNodeSocketRealm();
    const port = fakePort();
    realm.traffic(port, { sent: { t: 'op', id: 'a', method: 'rtdb.get', instance: 'second', path: 'x' } as InboundMessage });
    await settle();
    expect(realm.holdsProcess()).toBe(true);
    realm.traffic(port, { closed: true });
    await settle();
    expect(realm.holdsProcess()).toBe(false);
  });

  it('does not hold for Auth or Firestore frames that wait on nothing', async () => {
    const realm = createNodeSocketRealm();
    const port = fakePort();
    realm.traffic(port, { sent: { t: 'appConfig', options: {} } as InboundMessage });
    realm.traffic(port, { sent: { t: 'clock-subscribe' } as InboundMessage });
    await settle();
    expect(realm.holdsProcess()).toBe(false);
  });

  it('attaches as a node platform and keeps its timers from holding the process', () => {
    const realm = createNodeSocketRealm();
    expect(realm.platform).toBe('node');
    const timer = setTimeout(() => {}, 60_000);
    realm.releaseTimer(timer);
    expect(timer.hasRef()).toBe(false);
    clearTimeout(timer);
  });
});
