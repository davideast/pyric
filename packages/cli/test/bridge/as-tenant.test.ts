/**
 * A tenant named on a call's own identity reaches
 * `request.auth.token.firebase.tenant` in Firestore rules and
 * `auth.token.firebase.tenant` in Realtime Database rules, the same
 * projection a held identity gets through `projectIdentity`.
 */
import { describe, it, expect } from 'bun:test';
import { buildSandboxDispatcher } from '../../src/bridge/client/dispatch.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore, doc, setDoc } from 'pyric/firestore';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { setData, setRules as setDatabaseRules } from 'pyric/sandbox/database';

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tenanted/{doc} {
      allow read: if request.auth != null && request.auth.token.firebase.tenant == 'acme';
    }
    match /claimed/{doc} {
      allow read: if request.auth != null && request.auth.token.role == 'admin';
    }
  }
}`;

async function seededFirestore() {
  const sandbox = initializeSandbox();
  setFirestoreRules(sandbox, FIRESTORE_RULES);
  const admin = getAdminFirestore(sandbox);
  await setDoc(doc(admin, 'tenanted/t1'), { v: 1 });
  await setDoc(doc(admin, 'claimed/c1'), { v: 1 });
  return buildSandboxDispatcher(sandbox);
}

describe('transport as argument carries a tenant', () => {
  it('projects the tenant into Firestore rules', async () => {
    const dispatch = await seededFirestore();

    const allowed = await dispatch('firestore_get_document', {
      path: 'tenanted/t1',
      as: { uid: 'u', tenant: 'acme' },
    });
    expect(allowed.ok).toBe(true);
    await expect(
      dispatch('firestore_get_document', { path: 'tenanted/t1', as: { uid: 'u', tenant: 'other' } }),
    ).rejects.toThrow();
    await expect(
      dispatch('firestore_get_document', { path: 'tenanted/t1', as: { uid: 'u' } }),
    ).rejects.toThrow();
  });

  it('keeps claims and tenant together', async () => {
    const dispatch = await seededFirestore();

    const result = await dispatch('firestore_get_document', {
      path: 'claimed/c1',
      as: { uid: 'u', tenant: 'acme', claims: { role: 'admin' } },
    });
    expect(result.ok).toBe(true);
  });

  it('projects the tenant into Realtime Database rules', async () => {
    const sandbox = initializeSandbox();
    setData(sandbox, { '/tenanted/t1': { v: 1 } });
    setDatabaseRules(sandbox, {
      rules: {
        tenanted: { $id: { '.read': "auth != null && auth.token.firebase.tenant == 'acme'" } },
      },
    });
    const dispatch = buildSandboxDispatcher(sandbox);
    const simulate = async (auth: Record<string, unknown>) =>
      (await dispatch('rtdb_simulate_access', { operation: 'read', path: '/tenanted/t1', auth }))
        .data as { allowed: boolean };

    expect((await simulate({ uid: 'u', tenant: 'acme' })).allowed).toBe(true);
    expect((await simulate({ uid: 'u', tenant: 'other' })).allowed).toBe(false);
    expect((await simulate({ uid: 'u' })).allowed).toBe(false);
  });
});
