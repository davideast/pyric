/**
 * Scenario 7: Inventory Management
 *
 * Claims-based access control, quantity validation, immutable transactions,
 * get() for item reference, type validation with `in` operator.
 * Stdlib: auth, membership, lifecycle
 *
 * Rules: inline
 *
 * Migrated through `@pyric/sandbox` — operations dispatch through
 * `getFirestore(sandbox)` instead of `LocalEnvironment.execute`.
 */
import { describe, test, expect } from 'bun:test';
import { resolveModules } from 'pyric/rules/node';
import { makeRoot, runOp } from './_helpers.js';

const SOURCE = `import { isAuthenticated } from 'auth';
import { hasClaim } from 'membership';
import { fieldUnchanged } from 'lifecycle';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow read: if isAuthenticated();
      allow create: if isAuthenticated()
          && hasClaim('warehouse_staff')
          && request.resource.data.name != ''
          && request.resource.data.quantity >= 0
          && request.resource.data.createdBy == request.auth.uid;
      allow update: if isAuthenticated()
          && hasClaim('warehouse_staff')
          && fieldUnchanged('name')
          && fieldUnchanged('createdBy')
          && request.resource.data.quantity >= 0;
      allow delete: if isAuthenticated()
          && hasClaim('warehouse_manager');
    }
    match /transactions/{txId} {
      allow read: if isAuthenticated();
      allow create: if isAuthenticated()
          && hasClaim('warehouse_staff')
          && exists(/databases/$(database)/documents/items/$(request.resource.data.itemId))
          && request.resource.data.type in ['withdraw', 'deposit']
          && request.resource.data.amount > 0
          && request.resource.data.createdBy == request.auth.uid;
      allow update: if false;
      allow delete: if false;
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

const SEED = {
  'items/widget': { name: 'Widget', quantity: 100, createdBy: 'staff1' },
  'items/gadget': { name: 'Gadget', quantity: 0, createdBy: 'staff1' },
  'transactions/tx1': { itemId: 'widget', type: 'deposit', amount: 50, createdBy: 'staff1' },
};

const staffAuth = { uid: 'staff1', token: { warehouse_staff: true } };
const staff2Auth = { uid: 'staff2', token: { warehouse_staff: true } };
const managerAuth = { uid: 'mgr1', token: { warehouse_manager: true, warehouse_staff: true } };
const regularAuth = { uid: 'user1' };

describe('Scenario 7: Inventory Management', () => {
  test('staff creates item', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'items/bolt', auth: staffAuth, data: { name: 'Bolt', quantity: 500, createdBy: 'staff1' } });
    expect(r.allowed).toBe(true);
  });

  test('staff updates quantity', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'items/widget', auth: staffAuth, data: { quantity: 80 } });
    expect(r.allowed).toBe(true);
  });

  test('set quantity to zero', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'items/widget', auth: staffAuth, data: { quantity: 0 } });
    expect(r.allowed).toBe(true);
  });

  test('manager deletes item', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'items/gadget', auth: managerAuth });
    expect(r.allowed).toBe(true);
  });

  test('create withdraw transaction', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transactions/tx2', auth: staffAuth, data: { itemId: 'widget', type: 'withdraw', amount: 10, createdBy: 'staff1' } });
    expect(r.allowed).toBe(true);
  });

  test('create deposit transaction', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transactions/tx3', auth: staffAuth, data: { itemId: 'widget', type: 'deposit', amount: 25, createdBy: 'staff1' } });
    expect(r.allowed).toBe(true);
  });

  test('negative quantity denied on create', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'items/bad', auth: staffAuth, data: { name: 'Bad', quantity: -1, createdBy: 'staff1' } });
    expect(r.allowed).toBe(false);
  });

  test('negative quantity denied on update', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'items/widget', auth: staffAuth, data: { quantity: -5 } });
    expect(r.allowed).toBe(false);
  });

  test('non-staff denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'items/hack', auth: regularAuth, data: { name: 'Hack', quantity: 1, createdBy: 'user1' } });
    expect(r.allowed).toBe(false);
  });

  test('staff cannot delete item', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'items/widget', auth: staffAuth });
    expect(r.allowed).toBe(false);
  });

  test('empty name denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'items/noname', auth: staffAuth, data: { name: '', quantity: 1, createdBy: 'staff1' } });
    expect(r.allowed).toBe(false);
  });

  test('rename denied (immutable name)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'items/widget', auth: staffAuth, data: { name: 'Renamed', quantity: 100 } });
    expect(r.allowed).toBe(false);
  });

  test('zero amount transaction denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transactions/tx4', auth: staffAuth, data: { itemId: 'widget', type: 'deposit', amount: 0, createdBy: 'staff1' } });
    expect(r.allowed).toBe(false);
  });

  test('invalid transaction type denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transactions/tx5', auth: staffAuth, data: { itemId: 'widget', type: 'transfer', amount: 10, createdBy: 'staff1' } });
    expect(r.allowed).toBe(false);
  });

  test('spoof createdBy denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transactions/tx6', auth: staff2Auth, data: { itemId: 'widget', type: 'deposit', amount: 5, createdBy: 'staff1' } });
    expect(r.allowed).toBe(false);
  });

  test('update immutable transaction denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'transactions/tx1', auth: staffAuth, data: { amount: 999 } });
    expect(r.allowed).toBe(false);
  });
});
