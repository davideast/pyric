/**
 * The clients a live host lists in its health report: each page profile,
 * service worker and Node process connected to it, with the page it is on,
 * the user its last call ran as, and when the host last heard from it.
 */
import { describe, expect, it } from 'bun:test';
import { liveClientEmails } from 'pyric/sandbox/internal';
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

function observeFrom(clientSessionId: string, platform: string, script: unknown): BridgeMessage {
  const call = { service: 'auth', method: 'signInWithEmailAndPassword', at: 1, outcome: { status: 'ok' } };
  return frame(clientSessionId, platform, { t: 'observe', id: 'o2', call, script });
}

function unobserved(clientSessionId: string, platform: string, lists: Record<string, unknown>): BridgeMessage {
  return frame(clientSessionId, platform, { t: 'unobserved', id: 'u1', ...lists });
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

  it('takes the client id a page declares on its event subscription when it sends no appConfig, one client for its tabs', () => {
    const { live } = host();
    for (const session of ['s-tab-1', 's-tab-2']) {
      live.inbound(frame(session, 'browser', { t: 'sub', subId: `events-${session}`, target: 'events', tabId: session, clientId: 'profile-1' }));
    }
    expect(live.report().clients).toEqual([
      { kind: 'browser', clientId: 'profile-1', user: null, lastSeen: 1000 },
    ]);
  });

  it('lists a Node process by the client id the host stamps on its events, once the host names it', () => {
    const { live } = host();
    live.inbound(appConfig('s-node', 'node'));
    live.inbound(observe('s-node', 'node', 'user-1'));
    live.inbound(appConfig('s-page', 'browser', 'profile-1'));
    live.readClientIds((session) => (session === 's-node' ? 'page-2' : undefined));
    expect(live.report().clients).toEqual([
      { kind: 'node', clientId: 'page-2', user: 'user-1', lastSeen: 1000 },
      { kind: 'browser', clientId: 'profile-1', user: null, lastSeen: 1000 },
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

  it("lists what a Node process left unobserved under its client, follows each change, and drops it with the client", () => {
    const { live, tick } = host();
    live.inbound(unobserved('s-node', 'node', { unobservedAdmin: ['firebase-admin/remote-config'] }));
    live.readClientIds((session) => (session === 's-node' ? 'page-2' : undefined));
    expect(live.report().clients).toEqual([
      { kind: 'node', clientId: 'page-2', user: null, lastSeen: 1000, unobservedAdmin: ['firebase-admin/remote-config'] },
    ]);
    tick(5);
    const lists = {
      unobservedAdmin: ['firebase-admin/remote-config', 'firebase-admin/security-rules'],
      gatedAdmin: ['firebase-admin/app-check'],
    };
    live.inbound(unobserved('s-node', 'node', lists));
    expect(live.report().clients).toEqual([{ kind: 'node', clientId: 'page-2', user: null, lastSeen: 1005, ...lists }]);
    live.inbound(disconnect('s-node'));
    expect(live.report()).not.toHaveProperty('clients');
  });

  it('keeps no list that is not names in its shape, and none from a page', () => {
    const { live } = host();
    live.inbound(unobserved('s-node', 'node', { unobservedAdmin: ['firebase-admin/remote-config'] }));
    const malformed = [
      { unobservedAdmin: ['https://user:secret@cloudtrace.googleapis.com/v2?key=k'] },
      { unobservedAdmin: ['firebase-admin/remote-config/../../etc'] },
      { unobservedAdmin: ['firebase-admin/remote-config', 'firebase-admin/remote-config'] },
      { unobservedAdmin: Array.from({ length: 65 }, (_, index) => `firebase-admin/service-${index}`) },
      { unobservedAdmin: ['remote-config'] },
      { gatedAdmin: 'firebase-admin/app-check' },
    ];
    for (const lists of malformed) live.inbound(unobserved('s-node', 'node', lists));
    expect(live.report().clients?.[0]?.unobservedAdmin).toEqual(['firebase-admin/remote-config']);
    live.inbound(unobserved('s-page', 'browser', { unobservedAdmin: ['firebase-admin/remote-config'] }));
    expect(live.report().clients?.[1]).not.toHaveProperty('unobservedAdmin');
  });

  it('labels a service worker and a Node process by the script their observed calls name', () => {
    const { live } = host();
    live.inbound(observeFrom('s-sw', 'service-worker', '/sw.js'));
    live.inbound(observeFrom('s-node', 'node', 'jobs/nightly.mjs'));
    live.inbound(observeFrom('s-page', 'browser', '/sw.js'));
    expect(live.report().clients).toEqual([
      { kind: 'service-worker', clientId: 's-sw', label: '/sw.js', user: null, lastSeen: 1000 },
      { kind: 'node', clientId: 's-node', label: 'jobs/nightly.mjs', user: null, lastSeen: 1000 },
      { kind: 'browser', clientId: 's-page', user: null, lastSeen: 1000 },
    ]);
  });

  it('drops a script that is not a path of its kind\'s shape, and keeps the client and its last label', () => {
    const { live } = host();
    live.inbound(observeFrom('s-sw', 'service-worker', '/sw.js'));
    live.inbound(observeFrom('s-node', 'node', 'server.mjs'));
    const malformedWorker = ['https://app.example/sw.js', '//cdn.example/sw.js', '/sw.js?key=k', '/sw.js#top', 'sw.js', '', `/${'a'.repeat(256)}`, '/sw\njs', 7, null];
    const malformedNode = ['/home/ada/rooms/server.mjs', 'C:\\rooms\\server.mjs', '\\\\share\\server.mjs', 'file:///rooms/server.mjs', '', 'a'.repeat(257), 'server\u0000.mjs', ['server.mjs'], {}];
    for (const script of malformedWorker) live.inbound(observeFrom('s-sw', 'service-worker', script));
    for (const script of malformedNode) live.inbound(observeFrom('s-node', 'node', script));
    expect(live.report().clients?.map((client) => [client.kind, client.label])).toEqual([
      ['service-worker', '/sw.js'],
      ['node', 'server.mjs'],
    ]);
  });

  it('clears user attribution on sign-out and prevents cross-account uid/email pairing on account switch', () => {
    const { live } = host();
    live.inbound(appConfig('s-page', 'browser', 'profile-1'));
    live.inbound(register('s-page', '/items', 'user-a@example.test'));
    live.inbound(observe('s-page', 'browser', 'uid-a'));
    expect(live.report().clients?.[0]).toMatchObject({ user: 'uid-a', email: 'user-a@example.test' });
    expect(liveClientEmails(live.report().clients ?? []).get('uid-a')).toBe('user-a@example.test');

    // Sign-out clears both email and user
    live.inbound(update('s-page', '/items', { email: null }));
    expect(live.report().clients?.[0]?.user).toBeNull();
    expect(live.report().clients?.[0]).not.toHaveProperty('email');

    // Account B signs in before making an observed SDK call: uid-a is never paired with user-b
    live.inbound(update('s-page', '/items', { email: 'user-b@example.test' }));
    expect(live.report().clients?.[0]).toMatchObject({ user: null, email: 'user-b@example.test' });
    expect(liveClientEmails(live.report().clients ?? []).has('uid-a')).toBe(false);

    // Account B makes an observed call, then switches directly to Account C without an intermediate null
    live.inbound(observe('s-page', 'browser', 'uid-b'));
    expect(liveClientEmails(live.report().clients ?? []).get('uid-b')).toBe('user-b@example.test');
    live.inbound(update('s-page', '/items', { email: 'user-c@example.test' }));
    expect(live.report().clients?.[0]).toMatchObject({ user: null, email: 'user-c@example.test' });
    expect(liveClientEmails(live.report().clients ?? []).has('uid-b')).toBe(false);

    // If an observed call for uid-d arrives before presence updates from user-c, user-c's email is not paired with uid-d
    live.inbound(observe('s-page', 'browser', 'uid-c'));
    expect(live.report().clients?.[0]).toMatchObject({ user: 'uid-c', email: 'user-c@example.test' });
    live.inbound(observe('s-page', 'browser', 'uid-d'));
    expect(live.report().clients?.[0]?.user).toBe('uid-d');
    expect(live.report().clients?.[0]).not.toHaveProperty('email');
    expect(liveClientEmails(live.report().clients ?? []).has('uid-d')).toBe(false);
    expect(liveClientEmails([{ kind: 'browser', clientId: 'c1', user: 'uid-empty', email: '', lastSeen: 1 }]).has('uid-empty')).toBe(false);
  });

  it('ignores explicit email: undefined on route updates and clears anonymous uid when switching directly to an email account', () => {
    const { live } = host();
    live.inbound(appConfig('s-page', 'browser', 'profile-1'));
    live.inbound(register('s-page', '/items', 'user-a@example.test'));
    live.inbound(observe('s-page', 'browser', 'uid-a'));
    // In-memory presence.update carrying email: undefined must not be treated as email: null sign-out
    live.inbound(update('s-page', '/checkout', { email: undefined }));
    expect(live.report().clients?.[0]).toMatchObject({ label: '/checkout', user: 'uid-a', email: 'user-a@example.test' });

    // Anonymous session (no email) switches directly to user-b@example.test without an intermediate email: null
    live.inbound(update('s-page', '/anon', { email: null }));
    live.inbound(observe('s-page', 'browser', 'uid-anon'));
    expect(live.report().clients?.[0]).toMatchObject({ user: 'uid-anon' });
    expect(live.report().clients?.[0]).not.toHaveProperty('email');
    live.inbound(update('s-page', '/account', { email: 'user-b@example.test' }));
    expect(live.report().clients?.[0]).toMatchObject({ user: null, email: 'user-b@example.test' });
    expect(liveClientEmails(live.report().clients ?? []).has('uid-anon')).toBe(false);

    // Observed call carrying claims.email arriving right before matching presence.update retains uid
    live.inbound(
      frame('s-page', 'browser', {
        t: 'observe',
        id: 'o-claims',
        call: {
          service: 'firestore',
          method: 'getDoc',
          at: 2,
          outcome: { status: 'ok' },
          account: { uid: 'uid-e', claims: { email: 'user-e@example.test' } },
        },
      }),
    );
    live.inbound(update('s-page', '/account', { email: 'user-e@example.test' }));
    expect(live.report().clients?.[0]).toMatchObject({ user: 'uid-e', email: 'user-e@example.test' });
    expect(liveClientEmails(live.report().clients ?? []).get('uid-e')).toBe('user-e@example.test');
  });

  it('preserves non-email uids across email:null presence frames, clears stale email on unauthenticated observe, tracks uid switches/sign-out, and strips presence uid from frames', async () => {
    const { live } = host();
    live.inbound(appConfig('s-page', 'browser', 'profile-1'));

    // 1. Anonymous user ('u-anon', no email) runs an observed call and navigates with email: null
    live.inbound(observe('s-page', 'browser', 'u-anon'));
    live.inbound(update('s-page', '/items', { email: null }));
    expect(live.report().clients?.[0]).toMatchObject({ label: '/items', user: 'u-anon' });
    expect(live.report().clients?.[0]).not.toHaveProperty('email');

    // 2. Presence carrying uid: 'u-anon-2' (switching anonymous accounts) clears stale 'u-anon' without leaking uid onto frame
    const anonSwitchFrame = frame('s-page', 'browser', {
      t: 'op',
      id: 'p-anon-2',
      method: 'presence.update',
      route: '/items',
      email: null,
      uid: 'u-anon-2',
    });
    live.inbound(anonSwitchFrame);
    expect(live.report().clients?.[0]?.user).toBeNull();
    expect(JSON.stringify(anonSwitchFrame)).not.toContain('u-anon-2');

    // 3. Anonymous user 'u-anon-2' makes an observed call, then signs out explicitly via presence uid: null
    live.inbound(observe('s-page', 'browser', 'u-anon-2'));
    expect(live.report().clients?.[0]?.user).toBe('u-anon-2');
    live.inbound(
      frame('s-page', 'browser', {
        t: 'op',
        id: 'p-anon-out',
        method: 'presence.update',
        route: '/items',
        email: null,
        uid: null,
      }),
    );
    expect(live.report().clients?.[0]?.user).toBeNull();

    // 4. Email user signs in, runs an observed call, then runs an unauthenticated observed call: stale email is cleared
    live.inbound(update('s-page', '/items', { email: 'member@example.com' }));
    live.inbound(
      frame('s-page', 'browser', {
        t: 'observe',
        id: 'obs-member',
        call: {
          service: 'firestore',
          method: 'getDoc',
          at: 10,
          outcome: { status: 'ok' },
          account: { uid: 'u-member', claims: { email: 'member@example.com' } },
        },
      }),
    );
    expect(live.report().clients?.[0]).toMatchObject({ user: 'u-member', email: 'member@example.com' });
    live.inbound(observe('s-page', 'browser'));
    expect(live.report().clients?.[0]?.user).toBeNull();
    expect(live.report().clients?.[0]).not.toHaveProperty('email');
  });
});
