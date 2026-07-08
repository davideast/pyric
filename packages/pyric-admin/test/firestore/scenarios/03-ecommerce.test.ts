/**
 * Scenario 3: E-Commerce Order Lifecycle
 *
 * Order creation with product price validation via get(), state machine for
 * order fulfillment, role-based progression (seller vs buyer).
 * Stdlib: transitions, lifecycle, auth
 *
 * Rules: examples/scenarios/03-ecommerce.rules
 *
 * Migrated through `pyric/sandbox` — operations dispatch through
 * `getFirestore(sandbox)` instead of `LocalEnvironment.execute`.
 */
import { describe, test, expect } from 'bun:test';
import { resolveModules } from 'pyric/rules/node';
import { makeRoot, runOp } from './_helpers.js';

const SOURCE = `import { validTransition } from 'transitions';
import { fieldUnchanged } from 'lifecycle';
import { isAuthenticated } from 'auth';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /products/{productId} {
      allow read: if true;
      allow write: if false;
    }

    match /orders/{orderId} {
      allow read: if isAuthenticated()
          && (resource.data.buyerId == request.auth.uid
              || resource.data.sellerId == request.auth.uid);
      allow create: if isAuthenticated()
          && request.resource.data.buyerId == request.auth.uid
          && request.resource.data.status == 'pending'
          && request.resource.data.price == get(/databases/$(database)/documents/products/$(request.resource.data.productId)).data.price;
      allow update: if isAuthenticated()
          && fieldUnchanged('buyerId')
          && fieldUnchanged('sellerId')
          && fieldUnchanged('productId')
          && fieldUnchanged('price')
          && ((resource.data.sellerId == request.auth.uid
               && (validTransition('status', 'pending', 'confirmed')
                   || validTransition('status', 'confirmed', 'shipped')))
              || (resource.data.buyerId == request.auth.uid
                  && (validTransition('status', 'shipped', 'delivered')
                      || validTransition('status', 'pending', 'cancelled'))));
      allow delete: if false;
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

const SEED = {
  'products/p1': { name: 'Widget', price: 2999 },
  'products/p2': { name: 'Gadget', price: 4999 },
  'orders/o1': { buyerId: 'buyer1', sellerId: 'seller1', productId: 'p1', price: 2999, status: 'pending' },
  'orders/o2': { buyerId: 'buyer1', sellerId: 'seller1', productId: 'p1', price: 2999, status: 'confirmed' },
  'orders/o3': { buyerId: 'buyer1', sellerId: 'seller1', productId: 'p1', price: 2999, status: 'shipped' },
};

describe('Scenario 3: E-Commerce Order Lifecycle', () => {
  test('create order with valid price', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'orders/o4', auth: { uid: 'buyer1' }, data: { buyerId: 'buyer1', sellerId: 'seller1', productId: 'p1', price: 2999, status: 'pending' } });
    expect(r.allowed).toBe(true);
  });

  test('seller confirms order', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orders/o1', auth: { uid: 'seller1' }, data: { buyerId: 'buyer1', sellerId: 'seller1', productId: 'p1', price: 2999, status: 'confirmed' } });
    expect(r.allowed).toBe(true);
  });

  test('seller ships order', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orders/o2', auth: { uid: 'seller1' }, data: { buyerId: 'buyer1', sellerId: 'seller1', productId: 'p1', price: 2999, status: 'shipped' } });
    expect(r.allowed).toBe(true);
  });

  test('buyer marks delivered', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orders/o3', auth: { uid: 'buyer1' }, data: { buyerId: 'buyer1', sellerId: 'seller1', productId: 'p1', price: 2999, status: 'delivered' } });
    expect(r.allowed).toBe(true);
  });

  test('buyer cancels pending order', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orders/o1', auth: { uid: 'buyer1' }, data: { buyerId: 'buyer1', sellerId: 'seller1', productId: 'p1', price: 2999, status: 'cancelled' } });
    expect(r.allowed).toBe(true);
  });

  test('buyer cannot confirm order', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orders/o1', auth: { uid: 'buyer1' }, data: { buyerId: 'buyer1', sellerId: 'seller1', productId: 'p1', price: 2999, status: 'confirmed' } });
    expect(r.allowed).toBe(false);
  });

  test('cannot skip status pending to shipped', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orders/o1', auth: { uid: 'seller1' }, data: { buyerId: 'buyer1', sellerId: 'seller1', productId: 'p1', price: 2999, status: 'shipped' } });
    expect(r.allowed).toBe(false);
  });

  test('cannot cancel shipped order', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orders/o3', auth: { uid: 'buyer1' }, data: { buyerId: 'buyer1', sellerId: 'seller1', productId: 'p1', price: 2999, status: 'cancelled' } });
    expect(r.allowed).toBe(false);
  });

  test('wrong price denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'orders/o5', auth: { uid: 'buyer1' }, data: { buyerId: 'buyer1', sellerId: 'seller1', productId: 'p1', price: 1999, status: 'pending' } });
    expect(r.allowed).toBe(false);
  });

  test('price tamper on update denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orders/o1', auth: { uid: 'seller1' }, data: { buyerId: 'buyer1', sellerId: 'seller1', productId: 'p1', price: 100, status: 'confirmed' } });
    expect(r.allowed).toBe(false);
  });

  test('third party denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orders/o1', auth: { uid: 'stranger' }, data: { buyerId: 'buyer1', sellerId: 'seller1', productId: 'p1', price: 2999, status: 'confirmed' } });
    expect(r.allowed).toBe(false);
  });

  test('create for someone else denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'orders/o6', auth: { uid: 'buyer1' }, data: { buyerId: 'buyer2', sellerId: 'seller1', productId: 'p1', price: 2999, status: 'pending' } });
    expect(r.allowed).toBe(false);
  });
});
