/**
 * `pyric-admin` remote-dispatch arm — end-to-end, fully in-process
 * (remote sandbox, slice 1 / checkpoint 2).
 *
 * Extends checkpoint 1's headless harness (see
 * `pyric-tools/test/bridge/worker-relay.test.ts`): the REAL worker host
 * (`handleMessage` + fake `{ postMessage }` ports) behind the REAL bridge
 * core and consumer session, fronted by the EXACT branded handle
 * `connectRemoteSandbox()` returns (`createRemoteSandboxHandle`) — no
 * browser, no WS. `pyric-admin`'s `initializeApp({ sandbox })` receives
 * that handle unchanged, and `getDatabase` / `getAuth` must dispatch to
 * the remote arm: every operation relays to the worker (verified by
 * reading the worker's state through an independent direct port), and no
 * process-local tree/store is ever created (the handle's `onEvent`
 * throws — the local arms would trip it immediately).
 *
 * Coverage (per the checkpoint-2 spec):
 *   - RTDB set/get/update/remove/push round-trip, incl. sync `.key`
 *   - value listeners: `once('value')`, `on('value')` initial + update +
 *     detach (`off`), cross-visibility with browser-side writes
 *   - auth CRUD + custom claims + `getUser`/`getUserByEmail` via
 *     listUsers-filter + stateless token round-trip
 *   - the remediating throws on sync-only `Sandbox` members
 *   - the no-peer error ("open <serve url>") surfacing through the
 *     admin API
 *   - the local in-process arm still selected for plain sandboxes
 */

import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import type { AuthUserRecord } from 'pyric/auth';

import { createBridge, type Bridge } from '../../../pyric-tools/src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../pyric-tools/src/bridge/server/peer.js';
import {
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
} from '../../../pyric-tools/src/bridge/protocol.js';
import {
  createRemoteSandboxCore,
  createRemoteSandboxHandle,
  type RemoteSandbox,
} from '../../../pyric-tools/src/remote/index.js';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../pyric-tools/src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../../../pyric-tools/src/serve/worker/protocol.js';

import { initializeApp } from '../../src/app/index.js';
import { getDatabase } from '../../src/database/index.js';
import { getAuth } from '../../src/auth/index.js';

// ─── Harness (checkpoint 1's, minus persistence — not needed here) ─────────

const SERVE_URL = 'http://localhost:5000';

function makeWorkerCtx(): HostCtx {
  const sandbox = initializeSandbox();
  return {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'admin-remote-test',
    subs: new Map(),
  };
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Register a fake browser tab as the bridge's sandbox peer, backed by the
 *  REAL worker host (same shape as worker-relay.test.ts's connectTab). */
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

/** Build the EXACT production remote handle over an in-process transport. */
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

/** Drive one worker op through an INDEPENDENT direct port — the oracle
 *  proving admin-API operations really landed in the worker's sandbox
 *  (and letting "the browser app" write from its side). */
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

async function workerRtdbGet(ctx: HostCtx, path: string): Promise<unknown> {
  const wire = (await workerOp(ctx, {
    method: 'rtdb.get',
    path,
    actAs: { mode: 'admin' },
  })) as { value: unknown };
  return wire.value ?? null;
}

/** Fresh full stack: worker ctx + bridge + tab + remote-branded admin app. */
function makeStack() {
  const bridge = createBridge({ mode: 'sandbox', version: 'test' });
  const ctx = makeWorkerCtx();
  connectTab(bridge, ctx);
  const remote = connectRemote(bridge);
  const app = initializeApp({ sandbox: remote });
  return { bridge, ctx, remote, app };
}

// ─── Dispatch selection ─────────────────────────────────────────────────────

describe('pyric-admin remote dispatch — arm selection', () => {
  it('routes a remote-branded sandbox to the remote arm (never local state)', async () => {
    const { ctx, app } = makeStack();
    // The handle's `onEvent` throws — the local arms subscribe to it when
    // creating their WeakMap state, so merely getting working handles
    // proves the remote arm was selected before any local state existed.
    const db = getDatabase(app);
    const auth = getAuth(app);
    expect(db).toBeDefined();
    expect(auth).toBeDefined();

    // And the write lands in the WORKER's tree (independent direct port),
    // not in a private server-side tree.
    await db.ref('dispatch/probe').set({ via: 'remote-arm' });
    expect(await workerRtdbGet(ctx, 'dispatch/probe')).toEqual({ via: 'remote-arm' });
  });

  it('still routes a plain in-process sandbox to the local arm', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() });
    const db = getDatabase(app);
    await db.ref('local/probe').set({ via: 'local-arm' });
    expect((await db.ref('local/probe').get()).val()).toEqual({ via: 'local-arm' });
    // Local-arm signature: listeners are still not implemented there.
    expect(() => db.ref('local/probe').on('value', () => {})).toThrow(/not implemented/);
    // Awaiting a local ThenableReference resolves (regression for the
    // self-resolving-thenable unwrap loop fixed alongside the remote arm).
    const pushed = await db.ref('local/list').push({ v: 1 });
    expect(pushed.key).toHaveLength(20);
  });

  it('getDatabase(app) is a singleton per remote handle (shared listener registry)', () => {
    const { app } = makeStack();
    expect(getDatabase(app)).toBe(getDatabase(app));
  });
});

// ─── RTDB data plane ────────────────────────────────────────────────────────

describe('pyric-admin remote dispatch — RTDB', () => {
  it('set / get / update / remove round-trip through the worker', async () => {
    const { ctx, app } = makeStack();
    const db = getDatabase(app);

    await db.ref('rooms/lobby').set({ name: 'Lobby', open: true });
    const snap = await db.ref('rooms/lobby').get();
    expect(snap.exists()).toBe(true);
    expect(snap.key).toBe('lobby');
    expect(snap.val()).toEqual({ name: 'Lobby', open: true });
    expect(snap.child('name').val()).toBe('Lobby');

    await db.ref('rooms/lobby').update({ open: false, topic: 'welcome' });
    expect(await workerRtdbGet(ctx, 'rooms/lobby')).toEqual({
      name: 'Lobby',
      open: false,
      topic: 'welcome',
    });

    await db.ref('rooms/lobby').remove();
    const gone = await db.ref('rooms/lobby').get();
    expect(gone.exists()).toBe(false);
    expect(gone.val()).toBeNull();
  });

  it('set(null) deletes (relayed rtdb.set with null)', async () => {
    const { ctx, app } = makeStack();
    const db = getDatabase(app);
    await db.ref('tmp/x').set(1);
    await db.ref('tmp/x').set(null);
    expect(await workerRtdbGet(ctx, 'tmp/x')).toBeNull();
  });

  it('child()/parent/root are pure local path manipulation', async () => {
    const { app } = makeStack();
    const db = getDatabase(app);
    const ref = db.ref('a').child('b/c');
    expect(ref.key).toBe('c');
    expect(ref.parent!.key).toBe('b');
    expect(ref.root.key).toBeNull();
    expect(ref.toString()).toBe('sandbox://rtdb/a/b/c');
  });

  it('push() has a synchronous 20-char .key and commits the value remotely', async () => {
    const { ctx, app } = makeStack();
    const db = getDatabase(app);

    const thenable = db.ref('messages').push({ text: 'hi' });
    // `.key` is available SYNCHRONOUSLY — the client mints the push id.
    expect(thenable.key).toHaveLength(20);
    const ref = await thenable; // resolves once the relayed write commits
    expect(ref.key).toBe(thenable.key);
    expect(await workerRtdbGet(ctx, `messages/${thenable.key}`)).toEqual({ text: 'hi' });

    // Bare push() performs no write (upstream semantics) but still mints.
    const empty = db.ref('messages').push();
    expect(empty.key).toHaveLength(20);
    await empty;
    expect(await workerRtdbGet(ctx, `messages/${empty.key}`)).toBeNull();
  });

  it("once('value') resolves the current snapshot and detaches", async () => {
    const { app } = makeStack();
    const db = getDatabase(app);
    await db.ref('counter').set({ n: 1 });
    const snap = await db.ref('counter').once('value');
    expect(snap.val()).toEqual({ n: 1 });
    // A later write must not re-fire anything (detached) — just verify the
    // one-shot value was point-in-time.
    await db.ref('counter').set({ n: 2 });
    expect(snap.val()).toEqual({ n: 1 });
  });

  it("on('value') delivers initial + updates (incl. browser-side writes); off() detaches", async () => {
    const { ctx, app } = makeStack();
    const db = getDatabase(app);
    await db.ref('game/state').set({ round: 1 });

    const values: unknown[] = [];
    const cb = db.ref('game/state').on('value', (snap) => {
      values.push(snap.val());
    });
    await tick();
    expect(values).toEqual([{ round: 1 }]);

    // Server-side write → listener fires.
    await db.ref('game/state').set({ round: 2 });
    await tick();
    expect(values).toEqual([{ round: 1 }, { round: 2 }]);

    // BROWSER-side write (direct worker port — the app's own SDK) is
    // visible to the server listener: one shared tree.
    await workerOp(ctx, {
      method: 'rtdb.set',
      path: 'game/state',
      value: { round: 3 },
      actAs: { mode: 'admin' },
    });
    await tick();
    expect(values).toEqual([{ round: 1 }, { round: 2 }, { round: 3 }]);

    db.ref('game/state').off('value', cb);
    await db.ref('game/state').set({ round: 4 });
    await tick();
    expect(values).toHaveLength(3); // no delivery after off()
  });

  it("off() with no callback detaches every listener at the path", async () => {
    const { app } = makeStack();
    const db = getDatabase(app);
    const a: unknown[] = [];
    const b: unknown[] = [];
    db.ref('multi').on('value', (s) => a.push(s.val()));
    db.ref('multi').on('value', (s) => b.push(s.val()));
    await tick();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    db.ref('multi').off();
    await db.ref('multi').set({ x: 1 });
    await tick();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('non-value listeners / transactions / queries keep throwing "not implemented"', () => {
    const { app } = makeStack();
    const db = getDatabase(app);
    const ref = db.ref('x');
    expect(() => ref.on('child_added', () => {})).toThrow(/not implemented/);
    expect(() => ref.transaction(() => null)).toThrow(/not implemented/);
    expect(() => ref.orderByChild('y')).toThrow(/not implemented/);
    expect(() => ref.onDisconnect()).toThrow(/not implemented/);
  });
});

// ─── Auth ───────────────────────────────────────────────────────────────────

describe('pyric-admin remote dispatch — Auth', () => {
  it('createUser / getUser / getUserByEmail / listUsers relay to the worker pool', async () => {
    const { ctx, app } = makeStack();
    const auth = getAuth(app);

    const created = await auth.createUser({
      email: 'ada@example.com',
      password: 'correct-horse',
      displayName: 'Ada',
    });
    expect(created.uid).toBeTruthy();
    expect(created.email).toBe('ada@example.com');
    expect(created.displayName).toBe('Ada');

    // The user exists in the WORKER's pool (independent direct port).
    const workerUsers = (await workerOp(ctx, { method: 'auth.listUsers' })) as AuthUserRecord[];
    expect(workerUsers.map((u) => u.email)).toEqual(['ada@example.com']);

    const byUid = await auth.getUser(created.uid);
    expect(byUid.email).toBe('ada@example.com');
    const byEmail = await auth.getUserByEmail('ada@example.com');
    expect(byEmail.uid).toBe(created.uid);

    const listed = await auth.listUsers();
    expect(listed.users.map((u) => u.uid)).toEqual([created.uid]);
  });

  it('getUser / getUserByEmail reject clearly on a miss (list + filter)', async () => {
    const { app } = makeStack();
    const auth = getAuth(app);
    expect(auth.getUser('nope')).rejects.toThrow(/no user with uid "nope"/);
    expect(auth.getUserByEmail('nope@example.com')).rejects.toThrow(
      /no user with email "nope@example.com"/,
    );
  });

  it('updateUser and setCustomUserClaims relay auth.adminUpdateUser', async () => {
    const { app } = makeStack();
    const auth = getAuth(app);
    const created = await auth.createUser({ uid: 'ada', email: 'ada@example.com' });

    const updated = await auth.updateUser(created.uid, { displayName: 'Ada Lovelace' });
    expect(updated.displayName).toBe('Ada Lovelace');

    await auth.setCustomUserClaims('ada', { admin: true });
    expect((await auth.getUser('ada')).customClaims).toEqual({ admin: true });

    // `null` clears the claims map.
    await auth.setCustomUserClaims('ada', null);
    expect((await auth.getUser('ada')).customClaims).toBeUndefined();

    // Fields the worker can't express throw instead of silently dropping.
    expect(auth.updateUser('ada', { photoURL: 'https://x/y.png' })).rejects.toThrow(
      /photoURL/,
    );
  });

  it('deleteUser relays; worker errors (missing uid, dup uid) surface with their message', async () => {
    const { app } = makeStack();
    const auth = getAuth(app);
    await auth.createUser({ uid: 'gone', email: 'gone@example.com' });
    await auth.deleteUser('gone');
    expect(auth.getUser('gone')).rejects.toThrow(/no user with uid/);
    expect(auth.deleteUser('gone')).rejects.toThrow(/gone/);

    await auth.createUser({ uid: 'dup' });
    expect(auth.createUser({ uid: 'dup' })).rejects.toThrow(/dup/);
  });

  it('createCustomToken / verifyIdToken are stateless and need no relay', async () => {
    const { bridge, app } = makeStack();
    void bridge;
    const auth = getAuth(app);
    const token = await auth.createCustomToken('alice', { role: 'admin' });
    expect(token.startsWith('pyric-sandbox-custom:')).toBe(true);
    const decoded = await auth.verifyIdToken(token);
    expect(decoded.uid).toBe('alice');
    expect((decoded as Record<string, unknown>).role).toBe('admin');
  });

  it('unmodeled surface throws the canonical remote "not implemented" error', () => {
    const { app } = makeStack();
    const auth = getAuth(app);
    expect(auth.createSessionCookie('x', { expiresIn: 1 })).rejects.toThrow(
      /not implemented in pyric-admin\/auth remote sandbox backend/,
    );
    expect(() => auth.tenantManager()).toThrow(/not implemented/);
  });
});

// ─── Remediating throws on the handle's sync-only Sandbox members ──────────

describe('remote sandbox handle — sync-only Sandbox members', () => {
  it('admin / snapshot / history / onEvent / currentUser throw with remediation', () => {
    const { remote } = makeStack();
    expect(() => remote.admin).toThrow(/not available on a remote sandbox/);
    expect(() => remote.snapshot()).toThrow(/getSnapshot/);
    expect(() => remote.history()).toThrow(/not available on a remote sandbox/);
    expect(() => remote.onEvent(() => {})).toThrow(/not available on a remote sandbox/);
    expect(() => remote.currentUser).toThrow(/auth\.getCurrentUser/);
    expect(() => remote.reset()).toThrow(/not available on a remote sandbox/);
    expect(() => remote.loadSnapshot({} as never)).toThrow(/importState/);
  });

  it('withAuth works (pure local pair construction)', () => {
    const { remote } = makeStack();
    const ctx = remote.withAuth({ uid: 'alice' });
    expect(ctx.sandbox).toBe(remote);
    expect(ctx.auth).toEqual({ uid: 'alice' });
    expect(ctx.withAuth(null).auth).toBeNull();
  });

  it('dispose() closes the connection; later admin ops fail fast', async () => {
    const { remote, app } = makeStack();
    const db = getDatabase(app);
    await db.ref('pre').set(1);
    remote.dispose();
    expect(db.ref('pre').get()).rejects.toThrow(/connection closed/);
  });
});

// ─── No-peer failure mode through the admin API ─────────────────────────────

describe('remote dispatch — no browser tab connected', () => {
  it('RTDB and Auth calls fail fast with the "open <serve url>" guidance', async () => {
    // A bridge with NO tab registered: ops fail immediately, not after 30s.
    const bridge = createBridge({ mode: 'sandbox', version: 'test' });
    const remote = connectRemote(bridge);
    const app = initializeApp({ sandbox: remote });

    const started = Date.now();
    expect(getDatabase(app).ref('x').get()).rejects.toThrow(
      /open http:\/\/localhost:5000/,
    );
    expect(getAuth(app).createUser({ uid: 'x' })).rejects.toThrow(
      /open http:\/\/localhost:5000/,
    );
    try {
      await getDatabase(app).ref('x').set(1);
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('unavailable');
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
