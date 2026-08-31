import 'fake-indexeddb/auto';
import { describe, test, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { SimulateFirestoreRulesHandler } from '../../src/rules/simulator/handler.js';
import {
  getStorageSandbox,
  ref as storageRef,
  uploadBytes,
  getBlob,
} from '../../src/storage/index.js';
import { DataSnapshot } from '../../src/rules/rtdb/grammar/simulator.js';
import { SimulateHandler } from '../../src/rules/rtdb/simulation/handler.js';
import { compileRtdbRules } from '../../src/rules/rtdb/compiled-rules.js';
import {
  getDatabase,
  getAdminDatabase,
  get,
  set,
  update,
  ref as dbRef,
  sandbox as rtdbSandbox,
} from '../../src/database/index.js';

function uniqueDbName(label: string): string {
  return `pyric-soundness-tier4-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

// ═══════════════════════════════════════════════════════════════
// TIER 4: Real-World Application Scenarios
// ═══════════════════════════════════════════════════════════════

describe('Tier 4: Real-World Application Scenarios', () => {

  // ─── Scenario 1: Multi-Tenant SaaS Isolation ──────────────────
  describe('Scenario 1: Multi-Tenant SaaS Boundary Isolation', () => {
    const firestoreHandler = new SimulateFirestoreRulesHandler();

    const MULTI_TENANT_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tenants/{tenantId}/documents/{docId} {
      allow read, write: if request.auth != null
                          && request.auth.token.tenantId == tenantId
                          && !resource.data.archived
                          && !request.auth.token.suspended;
    }
  }
}`;

    test('Scenario 1.1: Active tenant user accessing non-archived tenant document is ALLOWED', () => {
      const res = firestoreHandler.simulate(MULTI_TENANT_RULES, [{
        description: 'valid tenant access',
        expectation: 'ALLOW',
        method: 'get',
        path: 'tenants/acme-corp/documents/doc1',
        auth: { uid: 'alice', token: { tenantId: 'acme-corp', suspended: false } },
        resource: { archived: false, title: 'Q3 Report' },
      }]);

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('ALLOW');
      }
    });

    test('Scenario 1.2: Tenant user with missing suspended claim fails closed via strict NOT (DENY)', () => {
      // In production, missing claim evaluated with ! throws EvalError and fails closed
      const res = firestoreHandler.simulate(MULTI_TENANT_RULES, [{
        description: 'missing suspended claim denied',
        expectation: 'DENY',
        method: 'get',
        path: 'tenants/acme-corp/documents/doc1',
        auth: { uid: 'alice', token: { tenantId: 'acme-corp' } }, // suspended is undefined
        resource: { archived: false, title: 'Q3 Report' },
      }]);

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('DENY');
      }
    });

    test('Scenario 1.3: User attempting cross-tenant traversal using .. is rejected (DENY)', () => {
      // Trying to traverse from allowed tenant to competitor tenant
      const res = firestoreHandler.simulate(MULTI_TENANT_RULES, [{
        description: 'cross-tenant path traversal denied',
        expectation: 'DENY',
        method: 'get',
        path: 'tenants/acme-corp/../globex/documents/doc1',
        auth: { uid: 'alice', token: { tenantId: 'acme-corp', suspended: false } },
        resource: { archived: false, title: 'Secret Plan' },
      }]);

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('DENY');
      }
    });
  });

  // ─── Scenario 2: E-Commerce Order State Machine & Deletions ───
  describe('Scenario 2: E-Commerce Order State Machine & Deletion Invariants', () => {
    test('Scenario 2.1: Order creation with items and payment details succeeds', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'customer-1' }));

      rtdbSandbox.setRules(db, {
        rules: {
          orders: {
            $orderId: {
              ".read": "auth != null",
              ".write": "auth != null",
              items: {
                ".validate": "newData.parent().child('payment').exists()",
              },
              payment: {
                method: { ".validate": "newData.isString()" },
                amount: { ".validate": "newData.isNumber()" },
              },
            },
          },
        },
      });

      await set(dbRef(db, '/orders/ord-100'), {
        items: { item1: { qty: 2 } },
        payment: { method: 'card', amount: 49.99 },
      });

      const snap = await get(dbRef(db, '/orders/ord-100/payment/amount'));
      expect(snap.val()).toBe(49.99);
    });

    test('Scenario 2.2: Multi-path update attempting to delete payment while items survive is rejected with PERMISSION_DENIED', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'customer-1' }));

      rtdbSandbox.setRules(db, {
        rules: {
          orders: {
            $orderId: {
              ".read": "auth != null",
              ".write": "auth != null",
              items: {
                ".validate": "newData.parent().child('payment').exists()",
              },
              payment: {
                method: { ".validate": "newData.isString()" },
                amount: { ".validate": "newData.isNumber()" },
              },
            },
          },
        },
      });

      // Seed valid order via admin handle
      const adminDb = getAdminDatabase(sandbox);
      await set(dbRef(adminDb, '/orders/ord-100'), {
        items: { item1: { qty: 2 } },
        payment: { method: 'card', amount: 49.99 },
      });

      // Customer attempts to update order by clearing payment
      let updateError: unknown = null;
      try {
        await update(dbRef(db, '/orders/ord-100'), {
          payment: null,
        });
      } catch (err) {
        updateError = err;
      }

      expect(updateError).toBeInstanceOf(Error);
      expect((updateError as Error).message).toContain('PERMISSION_DENIED');
    });
  });

  // ─── Scenario 3: Cross-Service RBAC & Storage Uploads ─────────
  describe('Scenario 3: Role-Based Access Control Across Storage & Firestore', () => {
    const RBAC_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /orgs/{orgId}/{allPaths=**} {
      allow read, write: if request.auth != null
                   && !request.auth.token.revoked
                   && firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.role == 'admin';
    }
  }
}`;

    test('Scenario 3.1: Admin member with valid revoked=false claim is authorized to upload', async () => {
      const sandbox = initializeSandbox({});
      // Seed Firestore membership
      sandbox.admin.setDocument('orgs/corp/members/user-admin', { role: 'admin' });

      const storage = getStorageSandbox(
        sandbox.withAuth({ uid: 'user-admin', token: { revoked: false } }),
        { dbName: uniqueDbName('rbac-allow'), rules: RBAC_STORAGE_RULES },
      );

      await uploadBytes(storageRef(storage, 'orgs/corp/assets/logo.png'), new Blob(['img-bytes']));
      const blob = await getBlob(storageRef(storage, 'orgs/corp/assets/logo.png'));
      expect(blob.size).toBe(9);
    });

    test('Scenario 3.2: Non-admin member is denied upload', async () => {
      const sandbox = initializeSandbox({});
      sandbox.admin.setDocument('orgs/corp/members/user-viewer', { role: 'viewer' });

      const storage = getStorageSandbox(
        sandbox.withAuth({ uid: 'user-viewer', token: { revoked: false } }),
        { dbName: uniqueDbName('rbac-deny-role'), rules: RBAC_STORAGE_RULES },
      );

      await expect(
        uploadBytes(storageRef(storage, 'orgs/corp/assets/logo.png'), new Blob(['img-bytes'])),
      ).rejects.toThrow(/unauthorized/);
    });

    test('Scenario 3.3: Admin member with missing revoked claim fails closed via strict NOT', async () => {
      const sandbox = initializeSandbox({});
      sandbox.admin.setDocument('orgs/corp/members/user-admin', { role: 'admin' });

      const storage = getStorageSandbox(
        sandbox.withAuth({ uid: 'user-admin', token: {} }), // missing revoked claim
        { dbName: uniqueDbName('rbac-deny-claim'), rules: RBAC_STORAGE_RULES },
      );

      await expect(
        uploadBytes(storageRef(storage, 'orgs/corp/assets/logo.png'), new Blob(['img-bytes'])),
      ).rejects.toThrow(/unauthorized/);
    });
  });

  // ─── Scenario 4: Social Network Activity Feed & Sibling Integrity ─
  describe('Scenario 4: Social Network Activity Feed & Sibling Integrity', () => {
    const handler = new SimulateHandler();

    const FEED_RULES = compileRtdbRules({
      rules: {
        posts: {
          $postId: {
            ".write": "auth != null",
            authorUid: { ".validate": "newData.isString() && newData.val() == auth.uid" },
            content: {
              ".validate": "newData.parent().child('authorUid').exists() && newData.isString()",
            },
          },
        },
      },
    });

    test('Scenario 4.1: Creating post with authorUid matching auth and valid content is ALLOWED', () => {
      const result = handler.execute(FEED_RULES, {
        operation: 'write',
        path: '/posts/post1',
        auth: { uid: 'author-123', token: {} },
        mockData: {},
        newData: {
          authorUid: 'author-123',
          content: 'Hello, world!',
        },
      });

      expect(result.success && result.data.allowed).toBe(true);
    });

    test('Scenario 4.2: Deleting authorUid while content remains is DENIED by sibling validate', () => {
      const result = handler.execute(FEED_RULES, {
        operation: 'write',
        path: '/posts/post1',
        auth: { uid: 'author-123', token: {} },
        mockData: {
          posts: {
            post1: {
              authorUid: 'author-123',
              content: 'Hello, world!',
            },
          },
        },
        newData: {
          content: 'Updated without author!',
          // authorUid deleted
        },
      });

      expect(result.success && result.data.allowed).toBe(false);
    });
  });

  // ─── Scenario 5: Full Sandbox Lifecycle & Audit Invariants ────
  describe('Scenario 5: Full Sandbox Lifecycle & Audit Invariants', () => {
    test('Scenario 5.1: RTDB and Storage start fail-closed; admin seeds state; client enforces invariants', async () => {
      const sandbox = initializeSandbox();

      // Step 1: RTDB unconfigured default deny
      const clientDb = getDatabase(sandbox.withAuth({ uid: 'client' }));
      await expect(set(dbRef(clientDb, '/app/config'), { v: 1 })).rejects.toThrow('PERMISSION_DENIED');

      // Step 2: Storage unconfigured default deny
      const clientStorage = getStorageSandbox(sandbox.withAuth({ uid: 'client' }), {
        dbName: uniqueDbName('scenario-5-storage'),
      });
      await expect(
        uploadBytes(storageRef(clientStorage, 'app.json'), new Blob(['{}'])),
      ).rejects.toThrow(/unauthorized/);

      // Step 3: Admin seeds RTDB config
      const adminDb = getAdminDatabase(sandbox);
      await set(dbRef(adminDb, '/app/config'), { v: 1, initialized: true });
      const configSnap = await get(dbRef(adminDb, '/app/config'));
      expect(configSnap.val()).toEqual({ v: 1, initialized: true });

      // Step 4: Configure client rules requiring initialized == true
      rtdbSandbox.setRules(clientDb, {
        rules: {
          app: {
            data: {
              ".read": true,
              ".write": "auth != null",
              ".validate": "root.child('app/config/initialized').val() === true",
            },
          },
        },
      });

      // Step 5: Client write now succeeds because admin seeded prerequisite state
      await set(dbRef(clientDb, '/app/data'), { payload: 'ok' });
      const dataSnap = await get(dbRef(clientDb, '/app/data'));
      expect(dataSnap.val()).toEqual({ payload: 'ok' });
    });

    test('Scenario 5.2: Chained parent existence check on deep non-existent path in real sandbox evaluates to false', () => {
      const snap = new DataSnapshot(null, '/', { rootConfig: true });
      const deepChild = snap.child('deep/virtual/path');
      const p1 = deepChild.parent();
      expect(p1).not.toBeNull();
      expect(p1!.exists()).toBe(false);

      const p2 = p1!.parent();
      expect(p2).not.toBeNull();
      expect(p2!.exists()).toBe(false);
    });
  });
});
