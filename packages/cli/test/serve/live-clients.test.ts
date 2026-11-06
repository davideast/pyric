/**
 * The clients a live host lists in its health report: each page profile,
 * service worker and Node process connected to it, with the page it is on,
 * the user its last call ran as, and when the host last heard from it.
 */
import { describe, expect, it } from 'bun:test';
import type { BridgeMessage } from '../../src/bridge/protocol.js';
import { createLiveHostState } from '../../src/serve/live-host-state.js';
import { createReproRecorder } from '../../src/serve/repro/recorder.js';
import type { InboundMessage } from '../../src/serve/worker/protocol.js';

function frame(clientSessionId: string, platform: string, message: Record<string, unknown>): BridgeMessage {
  return { type: 'worker-message', clientSessionId, platform, message } as unknown as BridgeMessage;
}

function appConfig(clientSessionId: string, platform: string, clientId?: string): BridgeMessage {
  const ids = clientId === undefined ? {} : { clientId };
  return frame(clientSessionId, platform, { t: 'appConfig', options: { projectId: 'staging' }, ...ids });
}

function register(clientSessionId: string, route: string, email?: string): BridgeMessage {
  const user = email === undefined ? {} : { email };
  const op = { t: 'op', id: 'p1', method: 'presence.register', clientId: 'presence-1', kind: 'tab', route, visibility: 'visible', ...user };
  return frame(clientSessionId, 'browser', op);
}

function update(clientSessionId: string, route: string, user: { email?: string | null } = {}): BridgeMessage {
  return frame(clientSessionId, 'browser', { t: 'op', id: 'p2', method: 'presence.update', clientId: 'presence-1', route, ...user });
}

function pageDisconnect(clientSessionId: string): BridgeMessage {
  return frame(clientSessionId, 'browser', { t: 'op', id: 'p3', method: 'presence.disconnect', clientId: 'presence-1' });
}

function observe(clientSessionId: string, platform: string, uid?: string): BridgeMessage {
  const account = uid === undefined ? {} : { account: { uid } };
  const call = { service: 'firestore', method: 'getDoc', at: 1, outcome: { status: 'ok' }, ...account };
  return frame(clientSessionId, platform, { t: 'observe', id: 'o1', call });
}

function disconnect(clientSessionId: string): BridgeMessage {
  return { type: 'worker-client-disconnect', clientSessionId } as unknown as BridgeMessage;
}

function host() {
  let now = 1000;
  const live = createLiveHostState({
    configProjectId: 'staging',
    configSource: 'firebaserc',
    optionName: '--project',
    warn: () => {},
    now: () => now,
  });
  return { live, tick: (ms: number) => (now += ms) };
}

describe('the live host clients', () => {
  it('lists each page profile, service worker and Node process, with its page, user and last frame', () => {
    const { live, tick } = host();
    live.inbound(appConfig('s-page', 'browser', 'profile-1'));
    live.inbound(register('s-page', '/orders/7?tab=open#top'));
    tick(5);
    live.inbound(observe('s-page', 'browser', 'user-1'));
    live.inbound(appConfig('s-sw', 'service-worker', 'profile-1'));
    tick(5);
    live.inbound(appConfig('s-node', 'node'));
    live.inbound(observe('s-node', 'node'));
    expect(live.report().clients).toEqual([
      { kind: 'browser', clientId: 'profile-1', label: '/orders/7', user: 'user-1', lastSeen: 1005 },
      { kind: 'service-worker', clientId: 'profile-1', user: null, lastSeen: 1005 },
      { kind: 'node', clientId: 's-node', user: null, lastSeen: 1010 },
    ]);
  });

  it('follows the page a live tab moves to and the user it signs in as, on a control connection that names no client', () => {
    const { live, tick } = host();
    live.inbound(register('s-page', '/'));
    live.inbound(observe('s-page', 'browser'));
    tick(10);
    live.inbound(update('s-page', '/account'));
    live.inbound(observe('s-page', 'browser', 'user-2'));
    expect(live.report().clients).toEqual([
      { kind: 'browser', clientId: 's-page', label: '/account', user: 'user-2', lastSeen: 1010 },
    ]);
  });

  it('drops a client once every connection it had is gone', () => {
    const { live } = host();
    live.inbound(appConfig('s-tab-1', 'browser', 'profile-1'));
    live.inbound(appConfig('s-tab-2', 'browser', 'profile-1'));
    live.inbound(appConfig('s-sw', 'service-worker', 'profile-1'));
    live.inbound(disconnect('s-tab-1'));
    expect(live.report().clients?.map((client) => client.kind)).toEqual(['browser', 'service-worker']);
    live.inbound(disconnect('s-tab-2'));
    live.inbound(disconnect('s-sw'));
    expect(live.report()).not.toHaveProperty('clients');
  });

  it('leaves out Studio and connections that never sent a frame', () => {
    const { live } = host();
    live.inbound(appConfig('s-studio', 'studio'));
    live.inbound({ type: 'worker-message', message: { t: 'appConfig', options: {} } } as unknown as BridgeMessage);
    expect(live.report()).not.toHaveProperty('clients');
  });

  it('carries the email the page sends with its presence, and follows it when the user changes', () => {
    const { live } = host();
    live.inbound(appConfig('s-page', 'browser', 'profile-1'));
    live.inbound(register('s-page', '/', 'ada@example.com'));
    expect(live.report().clients?.[0]?.email).toBe('ada@example.com');
    live.inbound(update('s-page', '/', { email: 'grace@example.com' }));
    expect(live.report().clients?.[0]?.email).toBe('grace@example.com');
    live.inbound(update('s-page', '/account'));
    expect(live.report().clients?.[0]?.email).toBe('grace@example.com');
    live.inbound(update('s-page', '/', { email: null }));
    expect(live.report().clients?.[0]).not.toHaveProperty('email');
  });

  it('drops a closed or reloaded tab at once, on the page presence disconnect', () => {
    const { live } = host();
    live.inbound(appConfig('s-tab-1', 'browser', 'profile-1'));
    live.inbound(register('s-tab-1', '/'));
    live.inbound(pageDisconnect('s-tab-1'));
    expect(live.report()).not.toHaveProperty('clients');
    live.inbound(appConfig('s-tab-2', 'browser', 'profile-1'));
    live.inbound(register('s-tab-2', '/next'));
    expect(live.report().clients).toEqual([
      { kind: 'browser', clientId: 'profile-1', label: '/next', user: null, lastSeen: 1000 },
    ]);
  });

  it('keeps the email in host memory: the frame the Node sandbox records and streams from carries none', async () => {
    const { live } = host();
    const message = register('s-page', '/', 'ada@example.com');
    live.inbound(message);
    expect(live.report().clients?.[0]?.email).toBe('ada@example.com');
    const handedOn = (message as { message: InboundMessage }).message;
    const recorder = createReproRecorder({ capture: async () => ({ at: 0, firestore: {}, rtdb: {}, auth: {} }) as never });
    await recorder.inbound('s-page', handedOn);
    const capture = JSON.stringify(await recorder.log());
    expect(capture).toContain('presence.register');
    expect(capture).not.toContain('ada@example.com');
    expect(JSON.stringify(message)).not.toContain('ada@example.com');
  });
});
