/**
 * Worker-mode `ClientAuth.tenantId`: the tenant crosses the port with the
 * sign-in.
 *
 * Sessions are per-port, so the tenant cannot live as worker state: the client
 * puts its `tenantId` on the sign-in message and the host mints the session
 * under it. What that buys the caller is the same contract the in-process SDK
 * gives: `user.tenantId` reads back, and the port's data ops evaluate rules
 * with `request.auth.token.firebase.tenant` set.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import * as client from '../../../src/serve/worker/client.js';
import { connectClientToHost, makeHostCtx, sleep } from './integration-support.js';

const TENANT_SCOPED = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tenants/{tenant}/notes/{note} {
      allow read, write: if request.auth != null
        && request.auth.token.firebase.tenant == tenant;
    }
  }
}`;

async function connectTenantHost(url: string) {
  const ctx = await makeHostCtx();
  const { getFirestore: adminFirestore } = await import('pyric/sandbox/admin-firestore');
  adminFirestore(ctx.sandbox.withAuth(null)).setRules(TENANT_SCOPED);
  const { db } = connectClientToHost(ctx, url);
  return { ctx, db };
}

describe('worker-mode Auth.tenantId', () => {
  it('defaults to null and reads back what was assigned', async () => {
    const { db } = await connectTenantHost('worker://tenant-default');
    const auth = client.getAuth(db);

    expect(auth.tenantId).toBeNull();

    auth.tenantId = 'acme';
    expect(auth.tenantId).toBe('acme');
  });

  it('forwards the tenant so the signed-in user carries it', async () => {
    const { db } = await connectTenantHost('worker://tenant-forward');
    const auth = client.getAuth(db);
    auth.tenantId = 'acme';

    const { user } = await client.signInAnonymously(auth);

    expect(user.tenantId).toBe('acme');
    expect(auth.currentUser?.tenantId).toBe('acme');
  });

  it('leaves tenantId null on the user when no tenant is set', async () => {
    const { db } = await connectTenantHost('worker://tenant-absent');
    const auth = client.getAuth(db);

    const { user } = await client.signInAnonymously(auth);

    expect(user.tenantId).toBeNull();
  });

  it("evaluates the port's rules under the forwarded tenant", async () => {
    const { db } = await connectTenantHost('worker://tenant-rules');
    const auth = client.getAuth(db);
    auth.tenantId = 'acme';
    await client.signInAnonymously(auth);
    await sleep();

    await client.setDoc(client.doc(db, 'tenants/acme/notes/n1'), { body: 'in tenant' });

    expect((await client.getDoc(client.doc(db, 'tenants/acme/notes/n1'))).data())
      .toEqual({ body: 'in tenant' });
    await expect(client.setDoc(client.doc(db, 'tenants/globex/notes/n1'), { body: 'nope' }))
      .rejects.toThrow(/permission|denied/i);
  });

  it('denies tenant-scoped writes for a port signed in without a tenant', async () => {
    const { db } = await connectTenantHost('worker://tenant-untenanted');
    const auth = client.getAuth(db);
    await client.signInAnonymously(auth);
    await sleep();

    await expect(client.setDoc(client.doc(db, 'tenants/acme/notes/n1'), { body: 'nope' }))
      .rejects.toThrow(/permission|denied/i);
  });
});
