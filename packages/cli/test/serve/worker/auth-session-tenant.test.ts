/**
 * Worker-mode per-port session tenant isolation and `updateEmail()` lifecycle:
 *
 * 1. Mutating client-side `auth.tenantId` after sign-in must never attach a
 *    tenant to an existing project-level session (or switch a tenanted session)
 *    across `reload()`, `getIdToken(true)`, `updateProfile()`, `updateEmail()`,
 *    `updatePassword()`, or `reauthenticateWithCredential()`, nor elevate
 *    Firestore, RTDB, or Storage Security Rules.
 * 2. Changing a verified user's email via `updateEmail()` resets
 *    `emailVerified` to `false`, refreshes the active session token and rules
 *    context immediately without `getIdToken(true)`, fires `onIdTokenChanged`
 *    (not `onAuthStateChanged`), revokes other ports' sessions for the same
 *    account, and treats same-email updates as idempotent no-ops.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { EmailAuthProvider, getAuth, sandbox as authSandbox } from 'pyric/auth';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { getStorageSandbox } from 'pyric/storage';
import * as client from '../../../src/serve/worker/client.js';
import { cleanupPort, handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { portSession } from '../../../src/serve/worker/host-auth.js';
import type { OpMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { connectClientToHost, makeHostCtx, until } from './integration-support.js';

const COMBINED_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tenants/{tenant}/items/{id} {
      allow read, write: if request.auth != null
        && request.auth.token.firebase.tenant == tenant;
    }
    match /verified/{id} {
      allow read, write: if request.auth != null
        && request.auth.token.email_verified == true;
    }
  }
}`;

const COMBINED_RTDB_RULES = {
  rules: {
    tenants: {
      $tenant: {
        '.write': 'auth != null && auth.token.firebase.tenant == $tenant',
      },
    },
    verified: {
      '.write': 'auth != null && auth.token.email_verified == true',
    },
  },
};

const COMBINED_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /tenants/{tenant}/{name} {
      allow write: if request.auth != null
        && request.auth.token.firebase.tenant == tenant;
    }
    match /verified/{name} {
      allow write: if request.auth != null
        && request.auth.token.email_verified == true;
    }
  }
}`;

async function outcome(op: () => Promise<unknown>): Promise<'allowed' | 'denied'> {
  try {
    await op();
    return 'allowed';
  } catch {
    return 'denied';
  }
}

async function setupClientHost(label: string) {
  const ctx = await makeHostCtx();
  const { getFirestore: adminFirestore } = await import('pyric/sandbox/admin-firestore');
  adminFirestore(ctx.sandbox.withAuth(null)).setRules(COMBINED_FIRESTORE_RULES);
  const { setRules: setRtdbRules } = await import('pyric/sandbox/database');
  setRtdbRules(ctx.sandbox, COMBINED_RTDB_RULES);
  const { db, hostPort } = connectClientToHost(ctx, `worker://${label}`);
  const auth = client.getAuth(db);
  return { ctx, db, auth, hostPort };
}

function makeRawPortHost(label: string) {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, {
    dbName: `raw-auth-tenant-${label}-${Math.random().toString(36).slice(2, 10)}`,
    rules: COMBINED_STORAGE_RULES,
  });
  const context: HostCtx = {
    sandbox,
    db: getFirestore(sandbox),
    instanceId: `auth-session-${label}`,
    subs: new Map(),
    flushPersistence: async () => {},
  };
  const messages: OutboundMessage[] = [];
  const port: PortLike = { postMessage: (message) => messages.push(message) };
  let seq = 0;
  async function send(message: Record<string, unknown>): Promise<ResMessage> {
    const id = `${label}-${++seq}`;
    await handleMessage(context, port, { ...message, t: 'op', id } as OpMessage);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const entry = messages[i];
      if (entry !== undefined && entry.t === 'res' && entry.id === id) return entry;
    }
    throw new Error('No response from host');
  }
  return { sandbox, context, port, send };
}

describe('worker-mode session tenant isolation on reload and account mutations', () => {
  it('never attaches client auth.tenantId to a project-level session on reload or sibling ops across Firestore, RTDB, and Storage', async () => {
    const { sandbox, context, port, send } = makeRawPortHost('project-user-spoof');
    try {
      const { getFirestore: adminFirestore } = await import('pyric/sandbox/admin-firestore');
      adminFirestore(sandbox.withAuth(null)).setRules(COMBINED_FIRESTORE_RULES);
      expect(await send({ method: 'setDatabaseRules', source: COMBINED_RTDB_RULES })).toMatchObject({ ok: true });

      authSandbox.createUser(getAuth(sandbox), {
        email: 'user@example.com',
        password: 'password123',
        emailVerified: true,
      });

      expect(await send({ method: 'auth.signInEmail', email: 'user@example.com', password: 'password123', tenantId: null })).toMatchObject({ ok: true });
      const uid = portSession(context, port)?.user.uid ?? 'missing';

      // Client reassigns auth.tenantId after signing in as a project-level user.
      expect(await send({ method: 'auth.setTenantId', tenantId: 'tenant-b' })).toMatchObject({ ok: true });

      const assertNoTenantEscalation = async () => {
        const session = portSession(context, port);
        expect(session?.user.tenantId).toBeNull();
        expect(session?.state.tenant).toBeUndefined();
        const firebaseClaim = session?.state.token?.firebase as { tenant?: unknown } | undefined;
        expect(firebaseClaim?.tenant).toBeUndefined();

        expect(await send({ method: 'setDoc', path: 'tenants/tenant-b/items/d1', data: { forged: true } })).toMatchObject({ ok: false });
        expect(await send({ method: 'rtdb.set', path: '/tenants/tenant-b/k1', value: 'forged' })).toMatchObject({ ok: false });
        expect(await send({ method: 'storage.putBytes', path: 'tenants/tenant-b/f1.txt', dataB64: btoa('forged') })).toMatchObject({ ok: false });
      };

      // reload()
      expect(await send({ method: 'auth.reload' })).toMatchObject({ ok: true });
      await assertNoTenantEscalation();

      // getIdToken(true)
      expect(await send({ method: 'auth.getIdToken', forceRefresh: true })).toMatchObject({ ok: true });
      await assertNoTenantEscalation();

      // updateProfile()
      expect(await send({ method: 'auth.updateProfile', displayName: 'Renamed' })).toMatchObject({ ok: true });
      await assertNoTenantEscalation();

      // updatePassword()
      expect(await send({ method: 'auth.updatePassword', password: 'password456' })).toMatchObject({ ok: true });
      await assertNoTenantEscalation();

      // reauthenticateWithCredential()
      expect(await send({
        method: 'auth.reauthenticateWithCredential',
        uid,
        tenantId: null,
        credential: {
          providerId: 'password',
          signInMethod: 'password',
          email: 'user@example.com',
          password: 'password456',
        },
      })).toMatchObject({ ok: true });
      await assertNoTenantEscalation();

      // updateEmail()
      expect(await send({ method: 'auth.updateEmail', email: 'next@example.com' })).toMatchObject({ ok: true });
      await assertNoTenantEscalation();
    } finally {
      await cleanupPort(context, port);
    }
  });

  it('keeps a tenanted user pinned to its own tenant when client auth.tenantId changes before reload or updateEmail', async () => {
    const { sandbox, context, port, send } = makeRawPortHost('tenant-a-pinned');
    try {
      const { getFirestore: adminFirestore } = await import('pyric/sandbox/admin-firestore');
      adminFirestore(sandbox.withAuth(null)).setRules(COMBINED_FIRESTORE_RULES);
      expect(await send({ method: 'setDatabaseRules', source: COMBINED_RTDB_RULES })).toMatchObject({ ok: true });

      expect(await send({
        method: 'auth.createUser',
        email: 'member@example.com',
        password: 'password123',
        tenantId: 'tenant-a',
      })).toMatchObject({ ok: true });

      // Client switches auth.tenantId to tenant-b and then null.
      expect(await send({ method: 'auth.setTenantId', tenantId: 'tenant-b' })).toMatchObject({ ok: true });
      expect(await send({ method: 'auth.reload' })).toMatchObject({ ok: true });
      expect(portSession(context, port)?.user.tenantId).toBe('tenant-a');
      expect(portSession(context, port)?.state.tenant).toBe('tenant-a');
      expect(await send({ method: 'setDoc', path: 'tenants/tenant-a/items/ok1', data: { ok: true } })).toMatchObject({ ok: true });
      expect(await send({ method: 'setDoc', path: 'tenants/tenant-b/items/bad1', data: { ok: true } })).toMatchObject({ ok: false });

      expect(await send({ method: 'auth.setTenantId', tenantId: null })).toMatchObject({ ok: true });
      expect(await send({ method: 'auth.updateEmail', email: 'member2@example.com' })).toMatchObject({ ok: true });
      expect(portSession(context, port)?.user.tenantId).toBe('tenant-a');
      expect(portSession(context, port)?.state.tenant).toBe('tenant-a');
      expect(await send({ method: 'setDoc', path: 'tenants/tenant-a/items/ok2', data: { ok: true } })).toMatchObject({ ok: true });
      expect(await send({ method: 'rtdb.set', path: '/tenants/tenant-b/bad2', value: true })).toMatchObject({ ok: false });
    } finally {
      await cleanupPort(context, port);
    }
  });

  it('keeps ClientAuth reload() from escalating tenantId on client handle and Firestore rules', async () => {
    const { ctx, db, auth } = await setupClientHost('client-reload-tenant');
    authSandbox.createUser(getAuth(ctx.sandbox), {
      email: 'plain@example.com',
      password: 'password123',
      emailVerified: true,
    });

    const cred = await client.signInWithEmailAndPassword(auth, 'plain@example.com', 'password123');
    expect(cred.user.tenantId).toBeNull();

    auth.tenantId = 'tenant-b';
    await client.reload(cred.user);

    expect(cred.user.tenantId).toBeNull();
    expect(auth.currentUser?.tenantId).toBeNull();
    const token = await cred.user.getIdTokenResult(false);
    const firebaseClaim = token.claims.firebase as { tenant?: unknown } | undefined;
    expect(firebaseClaim?.tenant).toBeUndefined();
    expect(await outcome(() => client.setDoc(client.doc(db, 'tenants/tenant-b/items/forged'), { forged: true }))).toBe('denied');
  });
});

describe('worker-mode updateEmail email_verified reset and idempotence', () => {
  it('resets emailVerified, updates token and rules across Firestore, RTDB, and Storage, and keeps same-email idempotent', async () => {
    const { sandbox, context, port, send } = makeRawPortHost('email-verified-reset');
    try {
      const { getFirestore: adminFirestore } = await import('pyric/sandbox/admin-firestore');
      adminFirestore(sandbox.withAuth(null)).setRules(COMBINED_FIRESTORE_RULES);
      expect(await send({ method: 'setDatabaseRules', source: COMBINED_RTDB_RULES })).toMatchObject({ ok: true });

      const record = authSandbox.createUser(getAuth(sandbox), {
        email: 'Ada@Example.com',
        password: 'password123',
        emailVerified: true,
      });

      expect(await send({ method: 'auth.signInEmail', email: 'Ada@Example.com', password: 'password123' })).toMatchObject({ ok: true });
      expect(await send({ method: 'setDoc', path: 'verified/before', data: { ok: true } })).toMatchObject({ ok: true });
      expect(await send({ method: 'rtdb.set', path: '/verified/before', value: true })).toMatchObject({ ok: true });
      expect(await send({ method: 'storage.putBytes', path: 'verified/before.txt', dataB64: btoa('ok') })).toMatchObject({ ok: true });

      // Idempotent same-email update (different casing) keeps emailVerified: true and rules passing.
      const beforeTokenRes = await send({ method: 'auth.getIdToken', forceRefresh: false });
      expect(beforeTokenRes.ok).toBe(true);
      const sameRes = await send({ method: 'auth.updateEmail', email: 'ada@example.com' });
      expect(sameRes.ok).toBe(true);
      if (!beforeTokenRes.ok || !sameRes.ok) throw new Error('Expected ok responses');
      expect((sameRes.value as { emailVerified?: boolean }).emailVerified).toBe(true);
      const afterSameTokenRes = await send({ method: 'auth.getIdToken', forceRefresh: false });
      expect(afterSameTokenRes.ok).toBe(true);
      if (!afterSameTokenRes.ok) throw new Error('Expected ok token response');
      expect(afterSameTokenRes.value).toBe(beforeTokenRes.value);
      expect(await send({ method: 'setDoc', path: 'verified/same', data: { ok: true } })).toMatchObject({ ok: true });

      // Real email change resets emailVerified: false and denies verified-only rules immediately.
      const changedRes = await send({ method: 'auth.updateEmail', email: 'new@example.com' });
      expect(changedRes.ok).toBe(true);
      if (!changedRes.ok) throw new Error('Expected ok updateEmail response');
      expect(changedRes.value).toMatchObject({
        email: 'new@example.com',
        emailVerified: false,
      });

      const stored = authSandbox.listUsers(getAuth(sandbox)).find((entry) => entry.uid === record.uid);
      expect(stored?.email).toBe('new@example.com');
      expect(stored?.emailVerified).toBe(false);

      const tokenRes = await send({ method: 'auth.getIdTokenResult', forceRefresh: false });
      expect(tokenRes.ok).toBe(true);
      if (!tokenRes.ok) throw new Error('Expected ok token result response');
      const claims = (tokenRes.value as { claims: Record<string, unknown> }).claims;
      expect(claims.email).toBe('new@example.com');
      expect(claims.email_verified).toBe(false);

      expect(await send({ method: 'setDoc', path: 'verified/after', data: { ok: true } })).toMatchObject({ ok: false });
      expect(await send({ method: 'rtdb.set', path: '/verified/after', value: true })).toMatchObject({ ok: false });
      expect(await send({ method: 'storage.putBytes', path: 'verified/after.txt', dataB64: btoa('nope') })).toMatchObject({ ok: false });
    } finally {
      await cleanupPort(context, port);
    }
  });

  it('updates ClientAuth handle, fires onIdTokenChanged only, revokes sibling port, and keeps same-email silent', async () => {
    const { ctx, db, auth } = await setupClientHost('client-update-email');
    const clock = getClock(ctx.sandbox);
    authSandbox.createUser(getAuth(ctx.sandbox), {
      email: 'verified@example.com',
      password: 'password123',
      emailVerified: true,
    });

    const { db: db2 } = connectClientToHost(ctx, 'worker://client-update-email-sibling');
    const auth2 = client.getAuth(db2);

    const cred1 = await client.signInWithEmailAndPassword(auth, 'verified@example.com', 'password123');
    const cred2 = await client.signInWithEmailAndPassword(auth2, 'verified@example.com', 'password123');
    expect(cred1.user.emailVerified).toBe(true);

    const stateFires: Array<string | null> = [];
    const tokenFires: Array<{ email: string | null; emailVerified: boolean } | null> = [];
    const unsubState = client.onAuthStateChanged(auth, (u) => stateFires.push(u?.uid ?? null));
    const unsubToken = client.onIdTokenChanged(auth, (u) => {
      tokenFires.push(u === null ? null : { email: u.email, emailVerified: u.emailVerified });
    });
    await until(() => stateFires.length === 1 && tokenFires.length === 1, 'initial auth observers');
    stateFires.length = 0;
    tokenFires.length = 0;

    // Idempotent same-email call does not fire onIdTokenChanged or reset emailVerified.
    await client.updateEmail(cred1.user, 'verified@example.com');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(cred1.user.emailVerified).toBe(true);
    expect(tokenFires).toEqual([]);
    expect(stateFires).toEqual([]);

    // Real email change resets emailVerified on both cred1.user and auth.currentUser.
    clock.advance(2_000);
    await client.updateEmail(cred1.user, 'changed@example.com');
    await until(() => tokenFires.length === 1, 'onIdTokenChanged after email update');

    unsubState();
    unsubToken();

    expect(cred1.user.email).toBe('changed@example.com');
    expect(cred1.user.emailVerified).toBe(false);
    expect(auth.currentUser?.emailVerified).toBe(false);
    expect(tokenFires).toEqual([{ email: 'changed@example.com', emailVerified: false }]);
    expect(stateFires).toEqual([]);
    expect(await outcome(() => client.setDoc(client.doc(db, 'verified/denied'), { ok: true }))).toBe('denied');

    // Sibling port is revoked on next forced refresh, while updating port still refreshes.
    const refreshed1 = await cred1.user.getIdTokenResult(true);
    expect(refreshed1.claims.email).toBe('changed@example.com');
    expect(refreshed1.claims.email_verified).toBe(false);

    await expect(cred2.user.getIdToken(true)).rejects.toMatchObject({ code: 'auth/user-token-expired' });
  });

  it('reauthenticateWithCredential on worker does not escalate tenant when auth.tenantId was mutated', async () => {
    const { ctx, db, auth } = await setupClientHost('client-reauth-tenant');
    authSandbox.createUser(getAuth(ctx.sandbox), {
      email: 'reauth@example.com',
      password: 'password123',
      emailVerified: true,
    });
    const cred = await client.signInWithEmailAndPassword(auth, 'reauth@example.com', 'password123');
    auth.tenantId = 'tenant-b';

    await client.reauthenticateWithCredential(
      cred.user,
      EmailAuthProvider.credential('reauth@example.com', 'password123'),
    );

    expect(cred.user.tenantId).toBeNull();
    expect(auth.currentUser?.tenantId).toBeNull();
    expect(await outcome(() => client.setDoc(client.doc(db, 'tenants/tenant-b/items/reauth'), { forged: true }))).toBe('denied');
  });
});
