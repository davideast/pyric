import { describe, expect, it } from 'bun:test';
import { wireAuthTabSync, type AuthOps } from '../../src/serve/entries/tab-sync-wiring.js';
import type { Auth, SeedUser } from 'pyric/auth';

// ─── Test channel: synchronous, delivers to all registered listeners ──────────

function makeChannel() {
  const listeners: Array<(ev: { data: unknown }) => void> = [];
  const posted: unknown[] = [];

  return {
    postMessage(msg: unknown): void {
      posted.push(msg);
      // Deliver to ALL listeners — unlike the real BroadcastChannel, injected
      // test channels typically deliver to the sender too, so the echo guard
      // is exercised here.
      for (const l of [...listeners]) l({ data: msg });
    },
    addEventListener(_type: 'message', l: (ev: { data: unknown }) => void): void {
      listeners.push(l);
    },
    removeEventListener(_type: 'message', l: (ev: { data: unknown }) => void): void {
      const i = listeners.indexOf(l);
      if (i !== -1) listeners.splice(i, 1);
    },
    close(): void { listeners.length = 0; },
    posted,
    listeners,
  };
}

// ─── Stub Auth ────────────────────────────────────────────────────────────────

function makeAuth(currentUid: string | null = null): Auth {
  return {
    currentUser: currentUid ? ({ uid: currentUid } as Auth['currentUser']) : null,
  } as Auth;
}

// ─── Stub authOps ─────────────────────────────────────────────────────────────

function makeAuthOps(currentUsers: SeedUser[] = []): AuthOps & {
  seedCalls: Array<SeedUser[]>;
  userChangeListeners: Array<() => void>;
} {
  const seedCalls: Array<SeedUser[]> = [];
  const userChangeListeners: Array<() => void> = [];

  const authOps: AuthOps & {
    seedCalls: Array<SeedUser[]>;
      userChangeListeners: Array<() => void>;
  } = {
    seedCalls,
    userChangeListeners,
    exportUsers: (_auth) => currentUsers,
    seedUsers: (_auth, users) => { seedCalls.push([...users]); for (const listener of userChangeListeners) listener(); },
    subscribeUsers: (_auth, cb) => {
      userChangeListeners.push(cb);
      return () => {
        const i = userChangeListeners.indexOf(cb);
        const hasListener = i !== -1;
        if (hasListener) userChangeListeners.splice(i, 1);
      };
    },
  };
  return authOps;
}

type PostedMsg = Record<string, unknown>;

function postedOfKind(channel: ReturnType<typeof makeChannel>, kind: string): PostedMsg[] {
  return (channel.posted as PostedMsg[]).filter((m) => m.kind === kind);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('wireAuthTabSync', () => {
  it('posts a hello on init so peers know a new tab joined', () => {
    const channel = makeChannel();
    const auth = makeAuth();
    const authOps = makeAuthOps();

    wireAuthTabSync(auth, authOps, channel, 'tab-A');

    const hellos = postedOfKind(channel, 'hello');
    expect(hellos).toHaveLength(1);
    expect(hellos[0]?.origin).toBe('tab-A');
  });

  it('broadcasts a state message when subscribeUsers fires', async () => {
    const channel = makeChannel();
    const auth = makeAuth('u1');
    const authOps = makeAuthOps([{ uid: 'u1', email: 'u1@test.com' } as SeedUser]);

    wireAuthTabSync(auth, authOps, channel, 'tab-A');

    // Simulate a user-DB change
    for (const l of authOps.userChangeListeners) l();

    // Wait for 100ms debounce
    await new Promise((r) => setTimeout(r, 150));

    const states = postedOfKind(channel, 'state');
    expect(states.length).toBeGreaterThanOrEqual(1);
    const last = states.at(-1);
    expect(last?.origin).toBe('tab-A');
    expect(last?.currentUid).toBeUndefined();
    expect(last?.users).toEqual([{ uid: 'u1', email: 'u1@test.com' }]);
  });

  it('shares accounts without adopting a remote signed-in UID', async () => {
    const channel = makeChannel();
    const auth = makeAuth();
    const authOps = makeAuthOps();

    wireAuthTabSync(auth, authOps, channel, 'tab-B');

    // Simulate an inbound state from Tab A
    const inbound = {
      kind: 'state',
      origin: 'tab-A',             // different origin — not echoed
      users: [{ uid: 'u1' }],
      currentUid: 'u1',
    };
    channel.postMessage(inbound);

    // Account application is independent of the legacy session field.
    await new Promise((r) => setTimeout(r, 10));

    expect(authOps.seedCalls).toHaveLength(1);
  });

  it('does not sign out when a legacy peer broadcasts currentUid: null', async () => {
    const channel = makeChannel();
    const auth = makeAuth('u1');
    const authOps = makeAuthOps();

    wireAuthTabSync(auth, authOps, channel, 'tab-B');

    channel.postMessage({ kind: 'state', origin: 'tab-A', users: [], currentUid: null });
    await new Promise((r) => setTimeout(r, 10));
    expect(auth.currentUser?.uid).toBe('u1');
    expect(authOps.seedCalls).toEqual([[]]);
  });

  it('ignores state messages from own origin (echo suppression)', async () => {
    const channel = makeChannel();
    const auth = makeAuth();
    const authOps = makeAuthOps();

    wireAuthTabSync(auth, authOps, channel, 'tab-A');

    // Deliver a state with the SAME origin — must be dropped
    channel.postMessage({ kind: 'state', origin: 'tab-A', users: [{ uid: 'u1' }], currentUid: 'u1' });
    await new Promise((r) => setTimeout(r, 10));

    expect(authOps.seedCalls).toHaveLength(0);
  });

  it('replies with current state when a hello arrives (late-join responder)', async () => {
    const channel = makeChannel();
    const auth = makeAuth('u2');
    const authOps = makeAuthOps([{ uid: 'u2' } as SeedUser]);

    wireAuthTabSync(auth, authOps, channel, 'tab-A');

    // Clear init messages so we only count the reply
    channel.posted.length = 0;

    // Another tab says hello
    channel.postMessage({ kind: 'hello', origin: 'tab-B' });

    // Reply is synchronous (no debounce on hello response)
    const states = postedOfKind(channel, 'state');
    expect(states).toHaveLength(1);
    expect(states[0]?.origin).toBe('tab-A');
    expect(states[0]?.currentUid).toBeUndefined();
    expect(states[0]?.users).toEqual([{ uid: 'u2' }]);
  });

  it('applying remote accounts does not echo synchronously or after debounce', async () => {
    const channel = makeChannel();
    const authOps = makeAuthOps();
    const disable = wireAuthTabSync(makeAuth(), authOps, channel, 'tab-B');
    channel.posted.length = 0;
    channel.postMessage({ kind: 'state', origin: 'tab-A', users: [{ uid: 'u1' }] });
    expect(authOps.seedCalls).toEqual([[{ uid: 'u1' }]]);
    expect(postedOfKind(channel, 'state')).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(postedOfKind(channel, 'state')).toHaveLength(1);
    disable();
  });

  it('disable() removes listeners and stops broadcasts', async () => {
    const channel = makeChannel();
    const auth = makeAuth();
    const authOps = makeAuthOps();

    const disable = wireAuthTabSync(auth, authOps, channel, 'tab-A');
    disable();

    channel.posted.length = 0;

    // After disable, subscribeUsers callbacks are removed
    expect(authOps.userChangeListeners).toHaveLength(0);

    // Posting a remote state should not apply anything
    channel.postMessage({ kind: 'state', origin: 'tab-B', users: [{ uid: 'u1' }], currentUid: 'u1' });
    await new Promise((r) => setTimeout(r, 10));

    expect(authOps.seedCalls).toHaveLength(0);
  });
});
