/**
 * Worker-mode standard token claims: a port session carries the account's
 * `email`, `email_verified` and `firebase.identities` on the ID token it
 * returns and on the `request.auth.token` its data ops evaluate rules under,
 * and a forced refresh picks up a verification recorded after sign-in.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import * as client from '../../../src/serve/worker/client.js';
import { connectClientToHost, makeHostCtx, sleep } from './integration-support.js';

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

describe('worker-mode standard token claims', () => {
  it('a verified password user passes an email_verified rule and reads the claims back', async () => {
    const { db } = await connectVerifiedHost('worker://claims-verified', true);
    const auth = client.getAuth(db);
    const { user } = await client.signInWithEmailAndPassword(auth, 'ada@example.com', 'secret-pw');
    await sleep();

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
    await sleep();

    await expect(client.setDoc(client.doc(db, 'verified/a'), { ok: true }))
      .rejects.toThrow(/permission|denied/i);

    authSandbox.updateUser(getAuth(ctx.sandbox), uid, { emailVerified: true });
    await client.getIdTokenResult(user, true);
    await sleep();
    await client.setDoc(client.doc(db, 'verified/a'), { ok: true });
  });
});
