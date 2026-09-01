/**
 * Multi-Tenant Security Rules Evaluation Stress Harness & Challenge Suite
 *
 * Empirical verification of Firestore security rules evaluation with multi-tenant tokens,
 * custom claims coexistence, and concurrent cross-handle isolation.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  actingAs,
  doc,
  collection,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  addDoc,
  writeBatch,
  runTransaction,
  onSnapshot,
  type DocumentSnapshot,
} from '../../src/firestore/index.js';


// ─── Rulesets ─────────────────────────────────────────────────────────────

const EXACT_TENANT_RULE = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tenant_scoped/{docId} {
      allow read: if request.auth.token.firebase.tenant == 'tenant-123';
      allow write: if request.auth.token.firebase.tenant == 'tenant-123';
    }
  }
}`;

const CLAIMS_COEXISTENCE_RULE = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /admin_tenant/{docId} {
      allow read, write: if request.auth.token.role == 'admin'
        && request.auth.token.firebase.tenant == 'tenant-123';
    }
    match /multi_claims/{docId} {
      allow read, write: if request.auth.token.firebase.tenant == 'tenant-123'
        && request.auth.token.role == 'admin'
        && request.auth.token.dept == 'platform'
        && request.auth.token.level == 4;
    }
  }
}`;

const PARTITIONED_TENANTS_RULE = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tenants/{tenantId}/data/{docId} {
      allow read, write: if request.auth != null
        && request.auth.token.firebase.tenant == tenantId;
    }
  }
}`;

const HELPER_FUNCTIONS_RULE = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    function hasValidTenant(expectedTenant) {
      return request.auth != null
        && request.auth.token != null
        && request.auth.token.firebase != null
        && request.auth.token.firebase.tenant == expectedTenant;
    }

    function isTenantRole(expectedTenant, expectedRole) {
      return hasValidTenant(expectedTenant)
        && request.auth.token.role == expectedRole;
    }

    match /projects/{tId}/docs/{dId} {
      allow read: if hasValidTenant(tId);
      allow write: if isTenantRole(tId, 'editor');
    }
  }
}`;

// ─── Test Suites ──────────────────────────────────────────────────────────

describe('Challenge 1: Exact tenant rule evaluation (request.auth.token.firebase.tenant == "tenant-123")', () => {
  it('allows read via getDoc when tenant matches', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, EXACT_TENANT_RULE);
    sandbox.admin.setDocument('tenant_scoped/doc1', { value: 'authorized' });

    const matchingUser = actingAs(sandbox, { uid: 'alice', tenant: 'tenant-123' });
    const snap = await getDoc(doc(matchingUser, 'tenant_scoped/doc1'));
    expect(snap.exists()).toBe(true);
    expect(snap.data()).toEqual({ value: 'authorized' });
  });

  it('denies read via getDoc when tenant does not match', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, EXACT_TENANT_RULE);
    sandbox.admin.setDocument('tenant_scoped/doc1', { value: 'secret' });

    const wrongTenantUser = actingAs(sandbox, { uid: 'bob', tenant: 'tenant-999' });
    await expect(getDoc(doc(wrongTenantUser, 'tenant_scoped/doc1'))).rejects.toThrow();
  });

  it('denies read via getDoc when tenant is missing', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, EXACT_TENANT_RULE);
    sandbox.admin.setDocument('tenant_scoped/doc1', { value: 'secret' });

    const noTenantUser = actingAs(sandbox, { uid: 'charlie' });
    await expect(getDoc(doc(noTenantUser, 'tenant_scoped/doc1'))).rejects.toThrow();
  });

  it('denies read via getDoc when unauthenticated (null auth)', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, EXACT_TENANT_RULE);
    sandbox.admin.setDocument('tenant_scoped/doc1', { value: 'secret' });

    const anonUser = actingAs(sandbox, null);
    await expect(getDoc(doc(anonUser, 'tenant_scoped/doc1'))).rejects.toThrow();
  });

  it('evaluates getDocs collection query with tenant matching vs mismatching', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, EXACT_TENANT_RULE);
    sandbox.admin.setDocument('tenant_scoped/item1', { name: 'Item 1' });
    sandbox.admin.setDocument('tenant_scoped/item2', { name: 'Item 2' });

    const matchingUser = actingAs(sandbox, { uid: 'alice', tenant: 'tenant-123' });
    const wrongTenantUser = actingAs(sandbox, { uid: 'bob', tenant: 'tenant-other' });
    const noTenantUser = actingAs(sandbox, { uid: 'charlie' });

    // Matching tenant can list collection
    const querySnap = await getDocs(collection(matchingUser, 'tenant_scoped'));
    expect(querySnap.size).toBe(2);

    // Mismatched or missing tenant gets permission-denied
    await expect(getDocs(collection(wrongTenantUser, 'tenant_scoped'))).rejects.toThrow();
    await expect(getDocs(collection(noTenantUser, 'tenant_scoped'))).rejects.toThrow();
  });

  it('evaluates writes (setDoc, updateDoc, deleteDoc, addDoc) with tenant matching vs mismatching', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, EXACT_TENANT_RULE);

    const matchingUser = actingAs(sandbox, { uid: 'alice', tenant: 'tenant-123' });
    const wrongTenantUser = actingAs(sandbox, { uid: 'bob', tenant: 'tenant-wrong' });
    const noTenantUser = actingAs(sandbox, { uid: 'charlie' });

    // setDoc: allowed for match, denied for mismatch/missing
    await expect(setDoc(doc(matchingUser, 'tenant_scoped/w1'), { created: true })).resolves.toBeUndefined();
    await expect(setDoc(doc(wrongTenantUser, 'tenant_scoped/w2'), { created: true })).rejects.toThrow();
    await expect(setDoc(doc(noTenantUser, 'tenant_scoped/w3'), { created: true })).rejects.toThrow();

    // updateDoc: allowed for match, denied for mismatch/missing
    await expect(updateDoc(doc(matchingUser, 'tenant_scoped/w1'), { updated: true })).resolves.toBeUndefined();
    await expect(updateDoc(doc(wrongTenantUser, 'tenant_scoped/w1'), { updated: true })).rejects.toThrow();
    await expect(updateDoc(doc(noTenantUser, 'tenant_scoped/w1'), { updated: true })).rejects.toThrow();

    // addDoc: allowed for match, denied for mismatch/missing
    await expect(addDoc(collection(matchingUser, 'tenant_scoped'), { auto: true })).resolves.toBeDefined();
    await expect(addDoc(collection(wrongTenantUser, 'tenant_scoped'), { auto: true })).rejects.toThrow();
    await expect(addDoc(collection(noTenantUser, 'tenant_scoped'), { auto: true })).rejects.toThrow();

    // deleteDoc: allowed for match, denied for mismatch/missing
    await expect(deleteDoc(doc(wrongTenantUser, 'tenant_scoped/w1'))).rejects.toThrow();
    await expect(deleteDoc(doc(noTenantUser, 'tenant_scoped/w1'))).rejects.toThrow();
    await expect(deleteDoc(doc(matchingUser, 'tenant_scoped/w1'))).resolves.toBeUndefined();
  });

  it('evaluates onSnapshot listener registration: allowed for match, denied for mismatch', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, EXACT_TENANT_RULE);
    sandbox.admin.setDocument('tenant_scoped/live1', { v: 1 });

    const matchingUser = actingAs(sandbox, { uid: 'alice', tenant: 'tenant-123' });
    const wrongTenantUser = actingAs(sandbox, { uid: 'bob', tenant: 'tenant-456' });

    // Matching user receives live snapshots
    let seenVal: unknown;
    const unsub = onSnapshot(doc(matchingUser, 'tenant_scoped/live1'), (snap) => {
      seenVal = snap.data()?.v;
    });

    await setDoc(doc(matchingUser, 'tenant_scoped/live1'), { v: 2 });
    expect(seenVal).toBe(2);
    unsub();

    // Wrong tenant receives permission-denied error callback
    let errorReceived: unknown;
    const unsubWrong = onSnapshot(
      doc(wrongTenantUser, 'tenant_scoped/live1'),
      {
        error: (err) => { errorReceived = err; },
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(errorReceived).toBeDefined();
    unsubWrong();
  });
});

describe('Challenge 2: Custom claims coexistence (role == "admin" && tenant == "tenant-123")', () => {
  it('satisfies truth table across role and tenant permutations', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, CLAIMS_COEXISTENCE_RULE);

    // 1. Both match (role=admin, tenant=tenant-123) -> ALLOW
    const fullMatch = actingAs(sandbox, {
      uid: 'u-both-match',
      tenant: 'tenant-123',
      token: { role: 'admin' },
    });
    await expect(
      setDoc(doc(fullMatch, 'admin_tenant/d1'), { ok: 1 }),
    ).resolves.toBeUndefined();

    // 2. Role matches ('admin'), tenant mismatches ('tenant-999') -> DENY
    const wrongTenant = actingAs(sandbox, {
      uid: 'u-wrong-tenant',
      tenant: 'tenant-999',
      token: { role: 'admin' },
    });
    await expect(
      setDoc(doc(wrongTenant, 'admin_tenant/d2'), { ok: 1 }),
    ).rejects.toThrow();

    // 3. Tenant matches ('tenant-123'), role mismatches ('viewer') -> DENY
    const wrongRole = actingAs(sandbox, {
      uid: 'u-wrong-role',
      tenant: 'tenant-123',
      token: { role: 'viewer' },
    });
    await expect(
      setDoc(doc(wrongRole, 'admin_tenant/d3'), { ok: 1 }),
    ).rejects.toThrow();

    // 4. Neither matches -> DENY
    const neitherMatch = actingAs(sandbox, {
      uid: 'u-neither',
      tenant: 'tenant-wrong',
      token: { role: 'viewer' },
    });
    await expect(
      setDoc(doc(neitherMatch, 'admin_tenant/d4'), { ok: 1 }),
    ).rejects.toThrow();

    // 5. Missing role claim, matching tenant -> DENY
    const missingRole = actingAs(sandbox, {
      uid: 'u-no-role',
      tenant: 'tenant-123',
    });
    await expect(
      setDoc(doc(missingRole, 'admin_tenant/d5'), { ok: 1 }),
    ).rejects.toThrow();

    // 6. Matching role, missing tenant -> DENY
    const missingTenant = actingAs(sandbox, {
      uid: 'u-no-tenant',
      token: { role: 'admin' },
    });
    await expect(
      setDoc(doc(missingTenant, 'admin_tenant/d6'), { ok: 1 }),
    ).rejects.toThrow();
  });

  it('coexists with arbitrary multi-field custom claims without interference', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, CLAIMS_COEXISTENCE_RULE);

    const multiClaimUser = actingAs(sandbox, {
      uid: 'lead-dev',
      tenant: 'tenant-123',
      token: {
        role: 'admin',
        dept: 'platform',
        level: 4,
        extraFlag: true,
        nested: { inner: 'val' },
      },
    });

    await expect(
      setDoc(doc(multiClaimUser, 'multi_claims/c1'), { data: 'pass' }),
    ).resolves.toBeUndefined();

    const readSnap = await getDoc(doc(multiClaimUser, 'multi_claims/c1'));
    expect(readSnap.data()).toEqual({ data: 'pass' });

    // Slight variance in one claim causes denial
    const partialUser = actingAs(sandbox, {
      uid: 'lead-dev-2',
      tenant: 'tenant-123',
      token: {
        role: 'admin',
        dept: 'platform',
        level: 3, // Level 3 instead of 4
      },
    });
    await expect(
      setDoc(doc(partialUser, 'multi_claims/c2'), { data: 'fail' }),
    ).rejects.toThrow();
  });
});

describe('Challenge 3: Concurrency and Cross-Handle Isolation Stress Test', () => {
  it('executes 300 interleaved concurrent operations across 5 tenant handles with zero cross-leakage', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, PARTITIONED_TENANTS_RULE);

    // 5 handles sharing the EXACT SAME UID on the SAME sandbox, but differing tenants
    const tenants = ['tenant-alpha', 'tenant-beta', 'tenant-gamma', 'tenant-delta', 'tenant-epsilon'];
    const handles = new Map(
      tenants.map((tid) => [tid, actingAs(sandbox, { uid: 'shared-agent-worker', tenant: tid })]),
    );

    // Untenanted handle with same UID
    const untenantedHandle = actingAs(sandbox, { uid: 'shared-agent-worker' });

    // Seed baseline documents for each tenant
    for (const tid of tenants) {
      sandbox.admin.setDocument(`tenants/${tid}/data/baseline`, { tenant: tid, count: 0 });
    }

    // Build 300 concurrent tasks:
    // - 150 authorized operations (each handle reads/writes its own partition)
    // - 150 unauthorized cross-tenant operations (handles attempting to read/write other partitions)
    const tasks: Promise<void>[] = [];

    for (let i = 0; i < 30; i++) {
      for (const tid of tenants) {
        const handle = handles.get(tid)!;
        const otherTid = tenants[(tenants.indexOf(tid) + 1) % tenants.length];

        // Authorized write to own partition
        tasks.push(
          (async () => {
            await setDoc(doc(handle, `tenants/${tid}/data/run-${i}`), {
              writtenBy: tid,
              iteration: i,
            });
            const snap = await getDoc(doc(handle, `tenants/${tid}/data/run-${i}`));
            expect(snap.exists()).toBe(true);
            expect(snap.data()?.writtenBy).toBe(tid);
          })(),
        );

        // Unauthorized write to another tenant's partition (MUST reject)
        tasks.push(
          (async () => {
            let threw = false;
            try {
              await setDoc(doc(handle, `tenants/${otherTid}/data/attack-${i}`), {
                breachedBy: tid,
              });
            } catch {
              threw = true;
            }
            expect(threw).toBe(true);
          })(),
        );

        // Unauthorized read from another tenant's baseline document (MUST reject)
        tasks.push(
          (async () => {
            let threw = false;
            try {
              await getDoc(doc(handle, `tenants/${otherTid}/data/baseline`));
            } catch {
              threw = true;
            }
            expect(threw).toBe(true);
          })(),
        );
      }

      // Untenanted handle attempting access on all partitions (MUST reject)
      tasks.push(
        (async () => {
          const targetTid = tenants[i % tenants.length];
          let threw = false;
          try {
            await getDoc(doc(untenantedHandle, `tenants/${targetTid}/data/baseline`));
          } catch {
            threw = true;
          }
          expect(threw).toBe(true);
        })(),
      );
    }

    // Await all concurrent tasks simultaneously
    await Promise.all(tasks);

    // Verify all authorized documents were written without corruption
    for (const tid of tenants) {
      for (let i = 0; i < 30; i++) {
        const docData = sandbox.admin.getDocument(`tenants/${tid}/data/run-${i}`);
        expect(docData).toEqual({ writtenBy: tid, iteration: i });
      }
    }
  });

  it('guarantees atomicity and tenant boundaries during batched writes and transactions', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, PARTITIONED_TENANTS_RULE);

    const handleA = actingAs(sandbox, { uid: 'userA', tenant: 'tenant-alpha' });

    // 1. Valid batch wholly inside tenant-alpha -> succeeds
    const goodBatch = writeBatch(handleA);
    goodBatch.set(doc(handleA, 'tenants/tenant-alpha/data/b1'), { n: 1 });
    goodBatch.set(doc(handleA, 'tenants/tenant-alpha/data/b2'), { n: 2 });
    await expect(goodBatch.commit()).resolves.toBeUndefined();

    // 2. Poisoned batch containing one cross-tenant write -> entire batch fails
    const badBatch = writeBatch(handleA);
    badBatch.set(doc(handleA, 'tenants/tenant-alpha/data/b3'), { n: 3 });
    badBatch.set(doc(handleA, 'tenants/tenant-beta/data/breach'), { bad: true });
    await expect(badBatch.commit()).rejects.toThrow();
    expect(sandbox.admin.getDocument('tenants/tenant-alpha/data/b3')).toBeNull();

    // 3. Valid transaction wholly inside tenant-alpha -> succeeds
    await expect(
      runTransaction(handleA, async (tx) => {
        const r1 = await tx.get(doc(handleA, 'tenants/tenant-alpha/data/b1'));
        tx.update(doc(handleA, 'tenants/tenant-alpha/data/b1'), { n: (r1.data()?.n as number) + 10 });
      }),
    ).resolves.toBeUndefined();
    expect(sandbox.admin.getDocument('tenants/tenant-alpha/data/b1')?.n).toBe(11);

    // 4. Transaction attempting write to cross-tenant document -> fails at commit
    await expect(
      runTransaction(handleA, async (tx) => {
        await tx.get(doc(handleA, 'tenants/tenant-alpha/data/b1'));
        tx.set(doc(handleA, 'tenants/tenant-beta/data/breach'), { bad: true });
      }),
    ).rejects.toThrow();
  });
});

describe('Challenge 4: Rules helper functions and expression evaluation', () => {
  it('correctly passes tenant arguments through rules functions for reads and role-based writes', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, HELPER_FUNCTIONS_RULE);

    const projectEditor = actingAs(sandbox, {
      uid: 'editor-1',
      tenant: 'proj-omega',
      token: { role: 'editor' },
    });

    const projectViewer = actingAs(sandbox, {
      uid: 'viewer-1',
      tenant: 'proj-omega',
      token: { role: 'viewer' },
    });

    const outsiderEditor = actingAs(sandbox, {
      uid: 'outsider-1',
      tenant: 'proj-other',
      token: { role: 'editor' },
    });

    // Editor on matching project: can read and write
    await expect(
      setDoc(doc(projectEditor, 'projects/proj-omega/docs/d1'), { title: 'Spec' }),
    ).resolves.toBeUndefined();
    const readSnap = await getDoc(doc(projectEditor, 'projects/proj-omega/docs/d1'));
    expect(readSnap.exists()).toBe(true);

    // Viewer on matching project: can read, but CANNOT write
    const viewerReadSnap = await getDoc(doc(projectViewer, 'projects/proj-omega/docs/d1'));
    expect(viewerReadSnap.exists()).toBe(true);
    await expect(
      setDoc(doc(projectViewer, 'projects/proj-omega/docs/d2'), { title: 'Hacked' }),
    ).rejects.toThrow();

    // Editor on wrong project: CANNOT read and CANNOT write
    await expect(
      getDoc(doc(outsiderEditor, 'projects/proj-omega/docs/d1')),
    ).rejects.toThrow();
    await expect(
      setDoc(doc(outsiderEditor, 'projects/proj-omega/docs/d3'), { title: 'Intrusion' }),
    ).rejects.toThrow();
  });
});



describe('Challenge 6: Boundary & Structural Edge Cases in Rules Evaluation', () => {
  const BOUNDARY_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /dynamic_tenants/{docId} {
      allow read: if request.auth != null
        && 'tenant' in request.auth.token.firebase
        && request.auth.token.firebase.tenant == resource.data.tenantId;
      allow create: if request.auth != null
        && request.auth.token.firebase.tenant == request.resource.data.tenantId;
    }
    match /bracket_access/{docId} {
      allow read: if request.auth.token.firebase['tenant'] == 'complex:tenant_id.v1@prod';
    }
  }
}`;

  it('evaluates resource.data binding against request.auth.token.firebase.tenant', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, BOUNDARY_RULES);

    sandbox.admin.setDocument('dynamic_tenants/d1', { tenantId: 'tenant-dynamic-1', secret: 'abc' });
    sandbox.admin.setDocument('dynamic_tenants/d2', { tenantId: 'tenant-dynamic-2', secret: 'xyz' });

    const user1 = actingAs(sandbox, { uid: 'u1', tenant: 'tenant-dynamic-1' });
    const user2 = actingAs(sandbox, { uid: 'u2', tenant: 'tenant-dynamic-2' });

    // User 1 can read d1, but not d2
    const s1 = await getDoc(doc(user1, 'dynamic_tenants/d1'));
    expect(s1.exists()).toBe(true);
    await expect(getDoc(doc(user1, 'dynamic_tenants/d2'))).rejects.toThrow();

    // User 2 can read d2, but not d1
    const s2 = await getDoc(doc(user2, 'dynamic_tenants/d2'));
    expect(s2.exists()).toBe(true);
    await expect(getDoc(doc(user2, 'dynamic_tenants/d1'))).rejects.toThrow();

    // Create enforces request.resource.data.tenantId == request.auth.token.firebase.tenant
    await expect(
      setDoc(doc(user1, 'dynamic_tenants/new1'), { tenantId: 'tenant-dynamic-1', text: 'ok' }),
    ).resolves.toBeUndefined();
    await expect(
      setDoc(doc(user1, 'dynamic_tenants/new2'), { tenantId: 'tenant-dynamic-2', text: 'illegal' }),
    ).rejects.toThrow();
  });

  it('evaluates bracket access and complex strings in tenant identifiers', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, BOUNDARY_RULES);

    const complexTenant = 'complex:tenant_id.v1@prod';
    const complexUser = actingAs(sandbox, { uid: 'u-complex', tenant: complexTenant });
    const normalUser = actingAs(sandbox, { uid: 'u-normal', tenant: 'normal-tenant' });

    sandbox.admin.setDocument('bracket_access/b1', { payload: 'hello' });

    const snap = await getDoc(doc(complexUser, 'bracket_access/b1'));
    expect(snap.exists()).toBe(true);
    expect(snap.data()).toEqual({ payload: 'hello' });

    await expect(getDoc(doc(normalUser, 'bracket_access/b1'))).rejects.toThrow();
  });
});

