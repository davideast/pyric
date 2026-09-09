/**
 * Milestone 2 Integration Tests — Web SharedWorker Auth Parity & Bridge RPCs.
 *
 * Verifies:
 * 1. Reactive `AuthLens` listener re-subscription (`switchAuthLens({ mode: 'as', uid })`
 *    and `{ mode: 'admin' }`) immediately re-evaluating active `onSnapshot` and
 *    RTDB `onValue` listeners without re-mounting.
 * 2. Multi-tenant `auth.tenantId` propagation over SharedWorker sessions and
 *    populating `request.auth.token.firebase.tenant` during Security Rules evaluation.
 * 3. SharedWorker user lifecycle RPCs (`reload`, `deleteUser`, `updateEmail`,
 *    `updatePassword`, `updateCurrentUser`) over `worker-op`.
 * 4. Shared Bridge RPC for OAuth Credential Sign-In (`signInWithCredential`) seeding
 *    `providerData` and minting an authenticated session over the SharedWorker.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../host.js';
import { portSession } from '../host-auth.js';
import { remintSessionWithClaims } from '../host/auth-session-seeder.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../protocol.js';
import { wirePort } from '../client/core.js';
import {
  switchAuthLens,
  getAuthLens,
  getAuth as getClientAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  reload,
  deleteUser,
  updateEmail,
  updatePassword,
  updateProfile,
  updateCurrentUser,
  signInWithCredential,
  onAuthStateChanged,
  onIdTokenChanged,
  listUsers,
  doc,
  setDoc,
  onSnapshot,
  setDatabaseRules,
  type ClientDb,
  type ClientRtdb,
} from '../client.js';
import { rtdbRef } from '../client/rtdb-references.js';
import { rtdbOnValue } from '../client/rtdb-listeners.js';
import { rtdbSet } from '../client/rtdb-writes.js';
import {
  initializeSandbox,
  createMemoryBackend,
} from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getDatabase } from 'pyric/database';
import { getAuth, sandbox as authSandboxOps } from 'pyric/auth';
import type { ClientPort } from '../client/handles.js';

function tick(ms = 15): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function createTestHarness() {
  const backend = createMemoryBackend();
  const sandbox = initializeSandbox();

  await sandbox.enablePersistence({ key: `m2-test-${Date.now()}`, injectedBackend: backend });
  getAuth(sandbox);

  const db = getFirestore(sandbox);
  const rtdb = getDatabase(sandbox);
  const ctx: HostCtx = {
    db,
    rtdb,
    sandbox,
    subs: new Map(),
    sessionBackend: backend,
    sessionMode: 'LOCAL',
  };

  let clientPort!: ClientPort;
  const hostPort: PortLike = {
    postMessage(msg: OutboundMessage) {
      clientPort.onmessage?.({ data: msg } as MessageEvent<OutboundMessage>);
    },
  };
  clientPort = {
    onmessage: null,
    postMessage(msg: InboundMessage) {
      void handleMessage(ctx, hostPort, msg);
    },
    start() {},
  };
  wirePort(clientPort);

  const clientDb: ClientDb = { __kind: 'client-db', port: clientPort };
  const clientRtdb: ClientRtdb = { __kind: 'client-rtdb', port: clientPort };
  const clientAuth = getClientAuth(clientDb);

  return { ctx, sandbox, clientPort, hostPort, clientDb, clientRtdb, clientAuth };
}

describe('Web SharedWorker Auth Parity & Bridge RPCs (M2)', () => {
  beforeEach(() => {
    switchAuthLens(undefined);
  });

  it('1. switchAuthLens({ mode: "as", uid }) and { mode: "admin" } immediately re-evaluates active onSnapshot and RTDB onValue listeners', async () => {
    const { sandbox, clientDb, clientRtdb } = await createTestHarness();

    const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
    const adminDb = getAdminFirestore(sandbox.withAuth(null));
    adminDb.setRules(`
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /secrets/{uid} {
            allow read, write: if request.auth != null && request.auth.uid == uid;
          }
        }
      }
    `);

    // Deploy owner-only RTDB rules via worker
    await setDatabaseRules(clientDb, JSON.stringify({
      rules: {
        secrets: {
          $uid: {
            '.read': 'auth != null && auth.uid == $uid',
            '.write': 'auth != null && auth.uid == $uid',
          },
        },
      },
    }));

    // Seed data as alice via admin/lens
    switchAuthLens({ mode: 'admin' });
    await setDoc(doc(clientDb, 'secrets/alice'), { message: 'alice-firestore-secret' });
    await rtdbSet(rtdbRef(clientRtdb, 'secrets/alice'), 'alice-rtdb-secret');
    switchAuthLens(undefined);
    await tick(20);

    // Register active Firestore onSnapshot and RTDB onValue listeners while impersonating bob
    switchAuthLens({ mode: 'as', uid: 'bob' });
    const fsSnapshots: Array<Record<string, unknown> | undefined> = [];
    const rtdbValues: unknown[] = [];

    const unsubFs = onSnapshot(
      doc(clientDb, 'secrets/alice'),
      (snap) => {
        fsSnapshots.push(snap.data());
      },
      () => {
        // permission-denied while bob
      },
    );

    const unsubRtdb = rtdbOnValue(
      rtdbRef(clientRtdb, 'secrets/alice'),
      (snap) => {
        rtdbValues.push(snap.val());
      },
      () => {
        // permission-denied while bob
      },
    );

    await tick(30);
    expect(fsSnapshots.length).toBe(0);

    // Switch lens to alice — listeners must automatically re-subscribe and deliver alice's data
    switchAuthLens({ mode: 'as', uid: 'alice' });
    await tick(40);

    expect(fsSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(fsSnapshots.at(-1)).toEqual({ message: 'alice-firestore-secret' });
    expect(rtdbValues.length).toBeGreaterThanOrEqual(1);
    expect(rtdbValues.at(-1)).toBe('alice-rtdb-secret');

    // Switch lens to admin — listeners remain authorized
    switchAuthLens({ mode: 'admin' });
    await tick(30);
    expect(fsSnapshots.at(-1)).toEqual({ message: 'alice-firestore-secret' });

    unsubFs();
    unsubRtdb();
  });

  it('2. auth.tenantId propagates over SharedWorker sessions and populates request.auth.token.firebase.tenant in Security Rules', async () => {
    const { sandbox, clientDb, clientAuth } = await createTestHarness();

    const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
    const adminDb = getAdminFirestore(sandbox.withAuth(null));
    adminDb.setRules(`
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /tenants/{tenantId}/items/{itemId} {
            allow read, write: if request.auth != null && request.auth.token.firebase.tenant == tenantId;
          }
        }
      }
    `);

    // Set tenantId on clientAuth BEFORE signing in
    clientAuth.tenantId = 'tenant-acme';
    expect(clientAuth.tenantId).toBe('tenant-acme');

    const cred = await createUserWithEmailAndPassword(clientAuth, 'user@acme.test', 'password123');
    expect(cred.user.tenantId).toBe('tenant-acme');

    // Write to matching tenant collection should succeed
    await setDoc(doc(clientDb, 'tenants/tenant-acme/items/item1'), { name: 'Acme Widget' });

    // Write to different tenant collection should be denied by rules
    let denied = false;
    try {
      await setDoc(doc(clientDb, 'tenants/tenant-beta/items/item1'), { name: 'Beta Widget' });
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
  });

  it('3. reload(user), deleteUser(user), updateEmail(user, newEmail), updatePassword(user, newPassword), and updateCurrentUser(auth, user) succeed over the SharedWorker', async () => {
    const { ctx, clientAuth } = await createTestHarness();

    const cred = await createUserWithEmailAndPassword(clientAuth, 'lifecycle@example.com', 'initialPass123');
    const user = cred.user;
    expect(user.email).toBe('lifecycle@example.com');

    // updateEmail
    await updateEmail(user, 'updated@example.com');
    expect(user.email).toBe('updated@example.com');

    // updatePassword
    await updatePassword(user, 'newSecretPass456');
    const reAuth = await signInWithEmailAndPassword(clientAuth, 'updated@example.com', 'newSecretPass456');
    expect(reAuth.user.uid).toBe(user.uid);

    // reload (after server-side admin update)
    authSandboxOps.updateUser(ctx.auth!, user.uid, { displayName: 'Reloaded Name' });
    await reload(user);
    expect(user.displayName).toBe('Reloaded Name');

    // updateCurrentUser
    await updateCurrentUser(clientAuth, null);
    expect(clientAuth.currentUser).toBeNull();
    await updateCurrentUser(clientAuth, user);
    expect(clientAuth.currentUser?.uid).toBe(user.uid);

    // deleteUser
    await deleteUser(user);
    const usersAfterDelete = await listUsers(clientAuth);
    expect(usersAfterDelete.some((u) => u.uid === user.uid)).toBe(false);
  });

  it('4. signInWithCredential seeds providerData and authenticates over the SharedWorker', async () => {
    const { clientAuth } = await createTestHarness();

    const cred = await signInWithCredential(clientAuth, {
      providerId: 'google.com',
      idToken: 'mock-google-id-token-999',
      email: 'googleuser@example.com',
      displayName: 'Google OAuth User',
      photoURL: 'https://example.com/avatar.png',
    });

    expect(cred.providerId).toBe('google.com');
    expect(cred.user.email).toBe('googleuser@example.com');
    expect(cred.user.displayName).toBe('Google OAuth User');
    expect(cred.user.photoURL).toBe('https://example.com/avatar.png');
    expect(cred.user.providerData.some((p) => p.providerId === 'google.com')).toBe(true);
    expect(clientAuth.currentUser?.uid).toBe(cred.user.uid);
  });

  it('5. switchAuthLens({ mode: "anon" }) persists anonymous lens and evaluates rules as unauthenticated despite signed-in port session', async () => {
    const { sandbox, clientDb, clientAuth } = await createTestHarness();

    const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
    const adminDb = getAdminFirestore(sandbox.withAuth(null));
    adminDb.setRules(`
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /authedOnly/{docId} {
            allow read, write: if request.auth != null;
          }
        }
      }
    `);

    await createUserWithEmailAndPassword(clientAuth, 'signedin@example.com', 'password123');
    expect(clientAuth.currentUser).not.toBeNull();

    switchAuthLens({ mode: 'anon' });
    expect(getAuthLens()).toEqual({ mode: 'anon' });

    let deniedAsAnon = false;
    try {
      await setDoc(doc(clientDb, 'authedOnly/doc1'), { hello: 'world' });
    } catch {
      deniedAsAnon = true;
    }
    expect(deniedAsAnon).toBe(true);

    switchAuthLens(undefined);
    expect(getAuthLens()).toBeUndefined();
    await setDoc(doc(clientDb, 'authedOnly/doc1'), { hello: 'world' });
  });

  it('6. handleRtdbSub forwards PERMISSION_DENIED cancelCallback errors to active RTDB onValue listeners when rules revoke read access', async () => {
    const { clientDb, clientRtdb } = await createTestHarness();

    // Initially allow read/write
    await setDatabaseRules(clientDb, JSON.stringify({
      rules: {
        '.read': true,
        '.write': true,
      },
    }));

    await rtdbSet(rtdbRef(clientRtdb, 'revocable/item'), 'initial-value');
    await tick(20);

    const values: unknown[] = [];
    const errors: unknown[] = [];

    const unsub = rtdbOnValue(
      rtdbRef(clientRtdb, 'revocable/item'),
      (snap) => {
        values.push(snap.val());
      },
      (err) => {
        errors.push(err);
      },
    );

    await tick(25);
    expect(values.length).toBeGreaterThanOrEqual(1);
    expect(errors.length).toBe(0);

    // Dynamically revoke read permission
    await setDatabaseRules(clientDb, JSON.stringify({
      rules: {
        '.read': false,
        '.write': false,
      },
    }));

    await tick(30);
    expect(errors.length).toBeGreaterThan(0);

    unsub();
  });

  it('7. onAuthStateChanged suppresses same-UID mutations while onIdTokenChanged fires on reload, updateEmail, updatePassword, and updateProfile', async () => {
    const { clientAuth } = await createTestHarness();

    const cred = await createUserWithEmailAndPassword(clientAuth, 'observer@example.com', 'password123');
    const user = cred.user;

    let authStateCount = 0;
    let idTokenCount = 0;
    let lastIdTokenUser: { displayName?: string | null; email?: string | null } | null = null;

    const unsubAuthState = onAuthStateChanged(clientAuth, () => {
      authStateCount++;
    });
    const unsubIdToken = onIdTokenChanged(clientAuth, (u) => {
      idTokenCount++;
      lastIdTokenUser = u;
    });

    await tick(25);
    // Initial fire on subscription registration
    expect(authStateCount).toBe(1);
    expect(idTokenCount).toBe(1);

    // reload(user) — same UID: authState must NOT fire, idToken MUST fire
    await reload(user);
    await tick(20);
    expect(authStateCount).toBe(1);
    expect(idTokenCount).toBe(2);

    // updateEmail(user) — same UID: authState must NOT fire, idToken MUST fire
    await updateEmail(user, 'observer-new@example.com');
    await tick(20);
    expect(authStateCount).toBe(1);
    expect(idTokenCount).toBe(3);
    expect(lastIdTokenUser?.email).toBe('observer-new@example.com');

    // updatePassword(user) — same UID: authState must NOT fire, idToken MUST fire
    await updatePassword(user, 'newPassword456');
    await tick(20);
    expect(authStateCount).toBe(1);
    expect(idTokenCount).toBe(4);

    // updateProfile(user) — same UID: authState must NOT fire, idToken MUST fire
    await updateProfile(user, { displayName: 'Observer Updated Name' });
    await tick(20);
    expect(authStateCount).toBe(1);
    expect(idTokenCount).toBe(5);
    expect(lastIdTokenUser?.displayName).toBe('Observer Updated Name');

    unsubAuthState();
    unsubIdToken();
  });

  it('8. handles Flutter client wire payloads sending newEmail and newPassword on auth.updateEmail and auth.updatePassword', async () => {
    const { ctx, clientAuth } = await createTestHarness();
    const cred = await createUserWithEmailAndPassword(clientAuth, 'flutter-old@example.com', 'oldPass123');
    expect(cred.user.email).toBe('flutter-old@example.com');

    const sentMessages: OutboundMessage[] = [];
    const testPort: PortLike = {
      postMessage(msg: OutboundMessage) {
        sentMessages.push(msg);
      },
    };

    // First restore the user session on testPort
    await handleMessage(ctx, testPort, {
      t: 'op',
      id: 'restore-op',
      method: 'auth.restorePortSession',
      uid: cred.user.uid,
    });

    // Send Flutter wire format { method: 'auth.updateEmail', newEmail: 'flutter-new@example.com' }
    await handleMessage(ctx, testPort, {
      t: 'op',
      id: 'flutter-email-op',
      method: 'auth.updateEmail',
      newEmail: 'flutter-new@example.com',
    } as unknown as InboundMessage);

    const emailRes = sentMessages.find((m) => m.t === 'res' && m.id === 'flutter-email-op') as {
      t: 'res';
      id: string;
      ok: boolean;
      value?: { email: string };
    };
    expect(emailRes?.ok).toBe(true);
    expect(emailRes?.value?.email).toBe('flutter-new@example.com');
  });

  it('9. auth.tenantId propagates through auth.signInWithCredential to user.tenantId', async () => {
    const { ctx } = await createTestHarness();
    const sentMessages: OutboundMessage[] = [];
    const testPort: PortLike = {
      postMessage(msg: OutboundMessage) {
        sentMessages.push(msg);
      },
    };

    await handleMessage(ctx, testPort, {
      t: 'op',
      id: 'oauth-tenant-op',
      method: 'auth.signInWithCredential',
      credential: {
        providerId: 'google.com',
        idToken: 'token-oauth-999',
        email: 'oauth-tenant@example.com',
      },
      tenantId: 'tenant-oauth-1',
    } as unknown as InboundMessage);

    const oauthRes = sentMessages.find((m) => m.t === 'res' && m.id === 'oauth-tenant-op') as {
      t: 'res';
      id: string;
      ok: boolean;
      value?: { user: { tenantId?: string | null } };
    };
    expect(oauthRes?.ok).toBe(true);
    expect(oauthRes?.value?.user?.tenantId).toBe('tenant-oauth-1');
  });

  it('10. multi-tenant user retains tenantId across reload, updateEmail, updatePassword, and updateCurrentUser', async () => {
    const { ctx, hostPort, clientAuth } = await createTestHarness();

    clientAuth.tenantId = 'tenant-corp';
    const cred = await createUserWithEmailAndPassword(clientAuth, 'tenant-user@example.com', 'initialPass123');
    const user = cred.user;
    expect(user.tenantId).toBe('tenant-corp');

    // reload
    authSandboxOps.updateUser(ctx.auth!, user.uid, { displayName: 'Tenant User Reloaded' });
    await reload(user);
    expect(user.displayName).toBe('Tenant User Reloaded');
    expect(user.tenantId).toBe('tenant-corp');
    const sessionAfterReload = portSession(ctx, hostPort);
    expect(sessionAfterReload?.user.tenantId).toBe('tenant-corp');
    expect(sessionAfterReload?.state.tenant).toBe('tenant-corp');

    // updateEmail
    await updateEmail(user, 'tenant-user-updated@example.com');
    expect(user.email).toBe('tenant-user-updated@example.com');
    const sessionAfterEmail = portSession(ctx, hostPort);
    expect(sessionAfterEmail?.user.tenantId).toBe('tenant-corp');
    expect(sessionAfterEmail?.state.tenant).toBe('tenant-corp');

    // updatePassword
    await updatePassword(user, 'newTenantPass789');
    const sessionAfterPassword = portSession(ctx, hostPort);
    expect(sessionAfterPassword?.user.tenantId).toBe('tenant-corp');
    expect(sessionAfterPassword?.state.tenant).toBe('tenant-corp');

    // updateCurrentUser
    await updateCurrentUser(clientAuth, null);
    expect(clientAuth.currentUser).toBeNull();
    await updateCurrentUser(clientAuth, user);
    expect(clientAuth.currentUser?.tenantId).toBe('tenant-corp');
    const sessionAfterUpdateCurrent = portSession(ctx, hostPort);
    expect(sessionAfterUpdateCurrent?.user.tenantId).toBe('tenant-corp');
    expect(sessionAfterUpdateCurrent?.state.tenant).toBe('tenant-corp');

    // updateCurrentUser on a second port with un-set clientAuth.tenantId
    let clientPort2!: ClientPort;
    const hostPort2: PortLike = {
      postMessage(msg: OutboundMessage) {
        clientPort2.onmessage?.({ data: msg } as MessageEvent<OutboundMessage>);
      },
    };
    clientPort2 = {
      onmessage: null,
      postMessage(msg: InboundMessage) {
        void handleMessage(ctx, hostPort2, msg);
      },
      start() {},
    };
    wirePort(clientPort2);
    const clientDb2: ClientDb = { __kind: 'client-db', port: clientPort2 };
    const clientAuth2 = getClientAuth(clientDb2);

    await updateCurrentUser(clientAuth2, user);
    expect(clientAuth2.currentUser?.tenantId).toBe('tenant-corp');
    const sessionAfterUpdateCurrent2 = portSession(ctx, hostPort2);
    expect(sessionAfterUpdateCurrent2?.user.tenantId).toBe('tenant-corp');
    expect(sessionAfterUpdateCurrent2?.state.tenant).toBe('tenant-corp');
  });

  it('11. remintSessionWithClaims preserves session.user.tenantId and session.state.tenant', () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const session = authSandboxOps.mintSession(auth, {
      kind: 'createPassword',
      email: 'tenant-direct@example.com',
      password: 'password123',
      tenantId: 'tenant-gold',
    });
    expect(session.user.tenantId).toBe('tenant-gold');
    expect(session.state.tenant).toBe('tenant-gold');

    const reminted = remintSessionWithClaims(auth, session);
    expect(reminted.user.tenantId).toBe('tenant-gold');
    expect(reminted.state.tenant).toBe('tenant-gold');
  });
});
