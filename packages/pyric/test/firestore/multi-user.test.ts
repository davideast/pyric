/**
 * Multi-user (programmatic) — Slice A/B of design rationale
 *
 * One sandbox, multiple identities via `actingAs(sandbox, { uid })`. Proves the
 * two claims a single-identity sandbox can't: (A) a write by one identity is
 * delivered to another identity's `onSnapshot` (shared store, cross-identity
 * fan-out), and (B) security rules evaluate per identity (`request.auth.uid`).
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  actingAs,
  doc,
  setDoc,
  onSnapshot,
  type DocumentSnapshot,
} from '../../src/firestore/index.js';

const PERMISSIVE = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

// Owner-write: any signed-in user reads; only the doc's declared author may write.
const OWNER_WRITE = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /rooms/{room}/msgs/{msg} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
        && request.auth.uid == request.resource.data.author;
    }
  }
}`;

// Multi-tenant isolated: only users whose token.firebase.tenant matches the path tenantId can access.
const TENANT_ISOLATED = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tenants/{tenantId}/records/{recordId} {
      allow read, write: if request.auth != null
        && request.auth.token.firebase.tenant == tenantId;
    }
  }
}`;

describe('multi-user (programmatic): one sandbox, distinct identities', () => {
  it('a write by one identity reaches another identity onSnapshot (shared store)', async () => {
    const sandbox = initializeSandbox();
    const alice = actingAs(sandbox, { uid: 'alice' });
    const bob = actingAs(sandbox, { uid: 'bob' });
    setRules(sandbox, PERMISSIVE);

    const seen: Array<Record<string, unknown> | undefined> = [];
    const unsub = onSnapshot(doc(bob, 'rooms/r1'), (snap: DocumentSnapshot) => {
      seen.push(snap.data() as Record<string, unknown> | undefined);
    });

    await setDoc(doc(alice, 'rooms/r1'), { owner: 'alice', n: 1 });

    // Bob's listener received Alice's write: cross-identity fan-out on one store.
    expect(seen.at(-1)).toEqual({ owner: 'alice', n: 1 });
    unsub();
  });

  it('rules evaluate per identity: bob cannot forge a message authored by alice', async () => {
    const sandbox = initializeSandbox();
    const alice = actingAs(sandbox, { uid: 'alice' });
    const bob = actingAs(sandbox, { uid: 'bob' });
    setRules(sandbox, OWNER_WRITE);

    // Alice writes her own message — allowed.
    await expect(
      setDoc(doc(alice, 'rooms/r1/msgs/m1'), { author: 'alice', body: 'hi' }),
    ).resolves.toBeUndefined();

    // Bob writing a message authored by alice — denied (request.auth.uid is bob).
    await expect(
      setDoc(doc(bob, 'rooms/r1/msgs/m2'), { author: 'alice', body: 'forged' }),
    ).rejects.toThrow();

    // Bob writing his own message — allowed.
    await expect(
      setDoc(doc(bob, 'rooms/r1/msgs/m3'), { author: 'bob', body: 'hey' }),
    ).resolves.toBeUndefined();
  });

  it('the anonymous identity (withAuth null) is denied by an auth-gated rule', async () => {
    const sandbox = initializeSandbox();
    const anon = actingAs(sandbox, null);
    setRules(sandbox, PERMISSIVE);
    await expect(setDoc(doc(anon, 'rooms/r2'), { x: 1 })).rejects.toThrow();
  });
});

describe('multi-tenant rules evaluation (request.auth.token.firebase.tenant)', () => {
  it('allows access when tenant matches security rule condition', async () => {
    const sandbox = initializeSandbox();
    const aliceAlpha = actingAs(sandbox, { uid: 'alice', tenant: 'tenant-alpha' });
    setRules(sandbox, TENANT_ISOLATED);

    await expect(
      setDoc(doc(aliceAlpha, 'tenants/tenant-alpha/records/r1'), { title: 'Secret Doc' }),
    ).resolves.toBeUndefined();
  });

  it('denies access when tenant does not match security rule condition', async () => {
    const sandbox = initializeSandbox();
    const bobBeta = actingAs(sandbox, { uid: 'bob', tenant: 'tenant-beta' });
    setRules(sandbox, TENANT_ISOLATED);

    await expect(
      setDoc(doc(bobBeta, 'tenants/tenant-alpha/records/r1'), { title: 'Intrusion' }),
    ).rejects.toThrow();
  });

  it('denies access when user has no tenant configured', async () => {
    const sandbox = initializeSandbox();
    const charlie = actingAs(sandbox, { uid: 'charlie' });
    setRules(sandbox, TENANT_ISOLATED);

    await expect(
      setDoc(doc(charlie, 'tenants/tenant-alpha/records/r1'), { title: 'No Tenant' }),
    ).rejects.toThrow();
  });

  it('respects explicit nested token.firebase.tenant override in rules evaluation', async () => {
    const sandbox = initializeSandbox();
    const userWithOverride = actingAs(sandbox, {
      uid: 'david',
      tenant: 'tenant-alpha',
      token: {
        firebase: { tenant: 'tenant-override' },
      },
    });
    setRules(sandbox, TENANT_ISOLATED);

    // Can access tenant-override
    await expect(
      setDoc(doc(userWithOverride, 'tenants/tenant-override/records/r1'), { title: 'Overridden' }),
    ).resolves.toBeUndefined();

    // Denied on tenant-alpha
    await expect(
      setDoc(doc(userWithOverride, 'tenants/tenant-alpha/records/r1'), { title: 'Mismatch' }),
    ).rejects.toThrow();
  });

  it('preserves custom claims alongside tenant during rules evaluation', async () => {
    const CLAIMS_AND_TENANT = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tenants/{tenantId}/admin_records/{docId} {
      allow read, write: if request.auth != null
        && request.auth.token.firebase.tenant == tenantId
        && request.auth.token.role == 'admin';
    }
  }
}`;
    const sandbox = initializeSandbox();
    setRules(sandbox, CLAIMS_AND_TENANT);

    const admin = actingAs(sandbox, {
      uid: 'admin-1',
      tenant: 'tenant-acme',
      token: { role: 'admin' },
    });
    const regularUser = actingAs(sandbox, {
      uid: 'user-1',
      tenant: 'tenant-acme',
      token: { role: 'viewer' },
    });

    await expect(
      setDoc(doc(admin, 'tenants/tenant-acme/admin_records/a1'), { confidential: true }),
    ).resolves.toBeUndefined();

    await expect(
      setDoc(doc(regularUser, 'tenants/tenant-acme/admin_records/a1'), { confidential: true }),
    ).rejects.toThrow();
  });

  it('delivers writes across identities within same tenant via onSnapshot', async () => {
    const sandbox = initializeSandbox();
    const aliceAlpha = actingAs(sandbox, { uid: 'alice', tenant: 'tenant-alpha' });
    const bobAlpha = actingAs(sandbox, { uid: 'bob', tenant: 'tenant-alpha' });
    setRules(sandbox, TENANT_ISOLATED);

    const seen: Array<Record<string, unknown> | undefined> = [];
    const unsub = onSnapshot(doc(bobAlpha, 'tenants/tenant-alpha/records/shared'), (snap: DocumentSnapshot) => {
      seen.push(snap.data() as Record<string, unknown> | undefined);
    });

    await setDoc(doc(aliceAlpha, 'tenants/tenant-alpha/records/shared'), { text: 'hello tenant' });

    expect(seen.at(-1)).toEqual({ text: 'hello tenant' });
    unsub();
  });
});

