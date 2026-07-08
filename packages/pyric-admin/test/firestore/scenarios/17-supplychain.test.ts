/**
 * Scenario 17: Supply Chain
 *
 * Cross-collection reference validation via exists() and get() arithmetic,
 * role-based claims for admin vs logistics, capacity enforcement.
 * Stdlib: auth, membership, validation, lifecycle
 *
 * Migrated through `pyric/sandbox` — operations dispatch through
 * `getFirestore(sandbox)` instead of `LocalEnvironment.execute`.
 */
import { describe, test, expect } from 'bun:test';
import { resolveModules } from 'pyric/rules/node';
import { makeRoot, runOp } from './_helpers.js';

const SOURCE = `import { isAuthenticated } from 'auth';
import { hasClaim } from 'membership';
import { hasRequired } from 'validation';
import { fieldUnchanged } from 'lifecycle';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {

    match /suppliers/{supplierId} {
      allow read: if isAuthenticated();
      allow create: if isAuthenticated()
          && hasClaim('role_admin')
          && hasRequired(['name', 'region']);
      allow update: if isAuthenticated()
          && hasClaim('role_admin');
      allow delete: if false;
    }

    match /warehouses/{warehouseId} {
      allow read: if isAuthenticated();
      allow create: if isAuthenticated()
          && hasClaim('role_admin')
          && hasRequired(['name', 'capacity', 'currentLoad', 'assignedSupplier'])
          && request.resource.data.currentLoad >= 0
          && exists(/databases/$(database)/documents/suppliers/$(request.resource.data.assignedSupplier));
      allow update: if isAuthenticated()
          && hasClaim('role_admin')
          && fieldUnchanged('assignedSupplier');
      allow delete: if false;
    }

    match /shipments/{shipmentId} {
      allow read: if isAuthenticated();

      allow create: if isAuthenticated()
          && hasClaim('role_logistics')
          && hasRequired(['supplierId', 'warehouseId', 'amount', 'status', 'createdBy'])
          && request.resource.data.createdBy == request.auth.uid
          && request.resource.data.status == 'pending'
          && request.resource.data.amount > 0
          && exists(/databases/$(database)/documents/suppliers/$(request.resource.data.supplierId))
          && get(/databases/$(database)/documents/warehouses/$(request.resource.data.warehouseId)).data.assignedSupplier == request.resource.data.supplierId
          && get(/databases/$(database)/documents/warehouses/$(request.resource.data.warehouseId)).data.currentLoad + request.resource.data.amount <= get(/databases/$(database)/documents/warehouses/$(request.resource.data.warehouseId)).data.capacity;

      allow update: if isAuthenticated()
          && hasClaim('role_logistics')
          && resource.data.createdBy == request.auth.uid
          && fieldUnchanged('supplierId')
          && fieldUnchanged('warehouseId')
          && fieldUnchanged('amount')
          && fieldUnchanged('createdBy');

      allow delete: if false;
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

const SEED = {
  'suppliers/s1': { name: 'Acme Parts', region: 'NA' },
  'suppliers/s2': { name: 'Global Materials', region: 'EU' },
  'warehouses/w1': { name: 'West Hub', capacity: 1000, currentLoad: 400, assignedSupplier: 's1' },
  'warehouses/w2': { name: 'East Hub', capacity: 500, currentLoad: 490, assignedSupplier: 's2' },
  'shipments/sh1': { supplierId: 's1', warehouseId: 'w1', amount: 100, status: 'pending', createdBy: 'logistics1' },
};

describe('Scenario 17: Supply Chain', () => {
  // ═══ ALLOW ═══

  test('create valid shipment', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'shipments/sh2', auth: { uid: 'logistics1', token: { role_logistics: true } }, data: { supplierId: 's1', warehouseId: 'w1', amount: 200, status: 'pending', createdBy: 'logistics1' } });
    expect(r.allowed).toBe(true);
  });

  test('update shipment status', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'shipments/sh1', auth: { uid: 'logistics1', token: { role_logistics: true } }, data: { supplierId: 's1', warehouseId: 'w1', amount: 100, status: 'shipped', createdBy: 'logistics1' } });
    expect(r.allowed).toBe(true);
  });

  test('create supplier', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'suppliers/s3', auth: { uid: 'admin1', token: { role_admin: true } }, data: { name: 'New Supplier', region: 'APAC' } });
    expect(r.allowed).toBe(true);
  });

  test('create warehouse (supplier exists)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'warehouses/w3', auth: { uid: 'admin1', token: { role_admin: true } }, data: { name: 'South Hub', capacity: 800, currentLoad: 0, assignedSupplier: 's1' } });
    expect(r.allowed).toBe(true);
  });

  // ═══ DENY ═══

  test('capacity exceeded denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'shipments/sh3', auth: { uid: 'logistics1', token: { role_logistics: true } }, data: { supplierId: 's2', warehouseId: 'w2', amount: 20, status: 'pending', createdBy: 'logistics1' } });
    expect(r.allowed).toBe(false);
  });

  test('wrong supplier-warehouse denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'shipments/sh4', auth: { uid: 'logistics1', token: { role_logistics: true } }, data: { supplierId: 's2', warehouseId: 'w1', amount: 50, status: 'pending', createdBy: 'logistics1' } });
    expect(r.allowed).toBe(false);
  });

  test('non-existent supplier denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'shipments/sh5', auth: { uid: 'logistics1', token: { role_logistics: true } }, data: { supplierId: 's999', warehouseId: 'w1', amount: 50, status: 'pending', createdBy: 'logistics1' } });
    expect(r.allowed).toBe(false);
  });

  test('non-logistics denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'shipments/sh6', auth: { uid: 'admin1', token: { role_admin: true } }, data: { supplierId: 's1', warehouseId: 'w1', amount: 50, status: 'pending', createdBy: 'admin1' } });
    expect(r.allowed).toBe(false);
  });

  test('non-creator update denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'shipments/sh1', auth: { uid: 'logistics2', token: { role_logistics: true } }, data: { supplierId: 's1', warehouseId: 'w1', amount: 100, status: 'shipped', createdBy: 'logistics1' } });
    expect(r.allowed).toBe(false);
  });

  test('zero amount denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'shipments/sh7', auth: { uid: 'logistics1', token: { role_logistics: true } }, data: { supplierId: 's1', warehouseId: 'w1', amount: 0, status: 'pending', createdBy: 'logistics1' } });
    expect(r.allowed).toBe(false);
  });

  test('negative amount denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'shipments/sh8', auth: { uid: 'logistics1', token: { role_logistics: true } }, data: { supplierId: 's1', warehouseId: 'w1', amount: -10, status: 'pending', createdBy: 'logistics1' } });
    expect(r.allowed).toBe(false);
  });

  test('amount change on update denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'shipments/sh1', auth: { uid: 'logistics1', token: { role_logistics: true } }, data: { supplierId: 's1', warehouseId: 'w1', amount: 999, status: 'shipped', createdBy: 'logistics1' } });
    expect(r.allowed).toBe(false);
  });

  test('warehouse with fake supplier denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'warehouses/w4', auth: { uid: 'admin1', token: { role_admin: true } }, data: { name: 'Fake Hub', capacity: 100, currentLoad: 0, assignedSupplier: 's999' } });
    expect(r.allowed).toBe(false);
  });

  test('negative currentLoad denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'warehouses/w5', auth: { uid: 'admin1', token: { role_admin: true } }, data: { name: 'Bad Hub', capacity: 100, currentLoad: -5, assignedSupplier: 's1' } });
    expect(r.allowed).toBe(false);
  });
});
