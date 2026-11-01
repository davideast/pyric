/**
 * Worker-mode standard token claims: a port session carries the account's
 * `email`, `email_verified` and `firebase.identities` on the ID token it
 * returns and on the `request.auth.token` its data ops evaluate rules under,
 * and a forced refresh picks up a verification recorded after sign-in.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';
import { getClock } from 'pyric/sandbox/internal';
import { cleanupPort, handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { portSession } from '../../../src/serve/worker/host-auth.js';
import type { OpMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import * as client from '../../../src/serve/worker/client.js';
import { connectClientToHost, makeHostCtx } from './integration-support.js';

const VERIFIED_ONLY = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /verified/{id} {
      allow read, write: if request.auth.token.email_verified == true
        && request.auth.token.firebase.identities.email[0] == request.auth.token.email;
    }
  }
}`;

async function connectVerifiedHost(url: string, emailVerified: boolean) {
  const ctx = await makeHostCtx();
  const { getFirestore: adminFirestore } = await import('pyric/sandbox/admin-firestore');
  adminFirestore(ctx.sandbox.withAuth(null)).setRules(VERIFIED_ONLY);
  const record = authSandbox.createUser(getAuth(ctx.sandbox), {
    email: 'ada@example.com', password: 'secret-pw', emailVerified,
  });
  const { db } = connectClientToHost(ctx, url);
  return { ctx, db, uid: record.uid };
}

const VERIFIED_DATABASE_RULES = { rules: { verified: { '.write': 'auth.token.email_verified == true' } } };

const VERIFIED_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /verified/{name} {
      allow write: if request.auth.token.email_verified == true;
    }
  }
}`;

/** A host with one port, driven by raw protocol messages. */
function portHost(label: string) {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, { dbName: `pyric-claims-${label}-${Math.random().toString(36).slice(2, 8)}`, rules: VERIFIED_STORAGE_RULES });
  const context: HostCtx = { sandbox, db: getFirestore(sandbox), instanceId: `claims-${label}`, subs: new Map(), flushPersistence: async () => {} };
  const messages: OutboundMessage[] = [];
  const port: PortLike = { postMessage: (message) => messages.push(message) };
  let seq = 0;
  async function send(message: Record<string, unknown>): Promise<ResMessage> {
    const id = `${label}-${++seq}`;
    await handleMessage(context, port, { ...message, t: 'op', id } as OpMessage);
    const response = messages.findLast((entry): entry is ResMessage => entry.t === 'res' && entry.id === id);
    if (response === undefined) throw new Error('No response from host');
    return response;
  }
  return { sandbox, context, port, send };
}

describe('worker-mode standard token claims in every rules engine', () => {
  for (const emailVerified of [true, false]) {
    const expected = emailVerified ? { ok: true } : { ok: false };
    it(`RTDB and Storage writes under email_verified rules: ${emailVerified ? 'verified allowed' : 'unverified denied'}`, async () => {
      const { sandbox, context, port, send } = portHost(emailVerified ? 'verified' : 'unverified');
      try {
        authSandbox.createUser(getAuth(sandbox), { email: 'ada@example.com', password: 'secret-pw', emailVerified });
        expect(await send({ method: 'setDatabaseRules', source: VERIFIED_DATABASE_RULES })).toMatchObject({ ok: true });
        expect(await send({ method: 'auth.signInEmail', email: 'ada@example.com', password: 'secret-pw' })).toMatchObject({ ok: true });
        expect(await send({ method: 'rtdb.set', path: '/verified/v', value: 1 })).toMatchObject(expected);
        expect(await send({ method: 'storage.putBytes', path: 'verified/a.txt', dataB64: btoa('x') })).toMatchObject(expected);
      } finally { await cleanupPort(context, port); }
    });
  }

  it('reauthentication keeps the standard claims and the JWT registered claims on the port token', async () => {
    const { sandbox, context, port, send } = portHost('reauth');
    try {
      authSandbox.createUser(getAuth(sandbox), { email: 'ada@example.com', password: 'secret-pw', emailVerified: true });
      await send({ method: 'auth.signInEmail', email: 'ada@example.com', password: 'secret-pw' });
      const uid = portSession(context, port)?.user.uid ?? 'missing';
      const credential = { providerId: 'password', signInMethod: 'password', email: 'ada@example.com', password: 'secret-pw' };
      expect(await send({ method: 'auth.reauthenticateWithCredential', uid, tenantId: null, credential })).toMatchObject({ ok: true });
      const token = portSession(context, port)?.state.token ?? {};
      expect(token.email_verified).toBe(true);
      expect(token.firebase).toEqual({ identities: { email: ['ada@example.com'] }, sign_in_provider: 'password' });
      // Rules read the minted token's JWT registered claims (#1341). Firebase's
      // docs: "`sub`: The user's Firebase UID" (firebase.google.com/docs/rules/rules-and-auth);
      // RTDB capture r42 allows sub, iat, exp, iss, aud and auth_time in deployed
      // rules. A custom claim cannot override any of them (`auth/reserved-claim`).
      expect(token.sub).toBe(uid);
      for (const key of ['aud', 'iss']) expect(typeof token[key]).toBe('string');
      for (const key of ['iat', 'exp', 'auth_time']) expect(Number.isInteger(token[key])).toBe(true);
      expect(await send({ method: 'setDatabaseRules', source: VERIFIED_DATABASE_RULES })).toMatchObject({ ok: true });
      expect(await send({ method: 'rtdb.set', path: '/verified/v', value: 1 })).toMatchObject({ ok: true });
    } finally { await cleanupPort(context, port); }
  });
});

const JWT_CLAIMS_DATABASE_RULES = {
  rules: {
    claims: { '.write': 'auth != null && auth.token.sub == auth.uid && auth.token.iss != null && auth.token.aud != null' },
    recent: { '.write': 'auth != null && auth.token.auth_time * 1000 > now - 300000' },
  },
};

const JWT_CLAIMS_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /claims/{id} {
      allow write: if request.auth.token.sub == request.auth.uid
        && request.auth.token.iss is string
        && request.auth.token.auth_time is int
        && request.auth.token.exp > request.auth.token.iat;
    }
  }
}`;

describe('worker-mode rules read the JWT registered claims (#1341)', () => {
  it('Firestore and RTDB allow sub == uid, iss, aud, iat, exp and auth_time for a port session', async () => {
    const { sandbox, context, port, send } = portHost('jwt-claims');
    try {
      const { getFirestore: adminFirestore } = await import('pyric/sandbox/admin-firestore');
      adminFirestore(sandbox.withAuth(null)).setRules(JWT_CLAIMS_FIRESTORE_RULES);
      authSandbox.createUser(getAuth(sandbox), { email: 'ada@example.com', password: 'secret-pw' });
      expect(await send({ method: 'setDatabaseRules', source: JWT_CLAIMS_DATABASE_RULES })).toMatchObject({ ok: true });
      expect(await send({ method: 'auth.signInEmail', email: 'ada@example.com', password: 'secret-pw' })).toMatchObject({ ok: true });
      const uid = portSession(context, port)?.user.uid ?? 'missing';
      expect(portSession(context, port)?.state.token?.sub).toBe(uid);
      expect(await send({ method: 'rtdb.set', path: '/claims/v', value: 1 })).toMatchObject({ ok: true });
      expect(await send({ method: 'setDoc', path: `claims/${uid}`, data: { ok: true } })).toMatchObject({ ok: true });
    } finally { await cleanupPort(context, port); }
  });

  it('RTDB denies a recent-login rule once the port session signed in more than five minutes ago (auth-claims RA-1)', async () => {
    const { sandbox, context, port, send } = portHost('jwt-recent');
    try {
      authSandbox.createUser(getAuth(sandbox), { email: 'ada@example.com', password: 'secret-pw' });
      expect(await send({ method: 'setDatabaseRules', source: JWT_CLAIMS_DATABASE_RULES })).toMatchObject({ ok: true });
      expect(await send({ method: 'auth.signInEmail', email: 'ada@example.com', password: 'secret-pw' })).toMatchObject({ ok: true });
      expect(await send({ method: 'rtdb.set', path: '/recent/v', value: 1 })).toMatchObject({ ok: true });
      getClock(sandbox).advance(6 * 60 * 1000);
      expect(await send({ method: 'rtdb.set', path: '/recent/v', value: 2 })).toMatchObject({ ok: false });
    } finally { await cleanupPort(context, port); }
  });
});

describe('worker-mode standard token claims', () => {
  it('a verified password user passes an email_verified rule and reads the claims back', async () => {
    const { db } = await connectVerifiedHost('worker://claims-verified', true);
    const auth = client.getAuth(db);
    const { user } = await client.signInWithEmailAndPassword(auth, 'ada@example.com', 'secret-pw');
    // The host set the port session before it answered sign-in (host-auth.ts).

    await client.setDoc(client.doc(db, 'verified/a'), { ok: true });

    const { claims } = await client.getIdTokenResult(user);
    expect(claims.email).toBe('ada@example.com');
    expect(claims.email_verified).toBe(true);
    expect(claims.firebase).toEqual({ identities: { email: ['ada@example.com'] }, sign_in_provider: 'password' });
  });

  it('an unverified user is denied until a forced refresh carries the verification', async () => {
    const { ctx, db, uid } = await connectVerifiedHost('worker://claims-unverified', false);
    const auth = client.getAuth(db);
    const { user } = await client.signInWithEmailAndPassword(auth, 'ada@example.com', 'secret-pw');
    // The host set the port session before it answered sign-in (host-auth.ts).

    await expect(client.setDoc(client.doc(db, 'verified/a'), { ok: true }))
      .rejects.toThrow(/permission|denied/i);

    authSandbox.updateUser(getAuth(ctx.sandbox), uid, { emailVerified: true });
    await client.getIdTokenResult(user, true);
    // The host refreshed the port's claims before it answered the forced refresh.
    await client.setDoc(client.doc(db, 'verified/a'), { ok: true });
  });
});
