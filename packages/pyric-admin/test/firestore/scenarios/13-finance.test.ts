/**
 * Scenario 13: Financial Transfer
 *
 * Account ownership, transfer validation with get()/exists() to verify
 * balances and receiver existence, self-transfer blocked, immutable transfers.
 * Stdlib: auth, lifecycle, validation
 *
 * Migrated through `@pyric/sandbox` — operations dispatch through
 * `getFirestore(sandbox)` instead of `LocalEnvironment.execute`.
 */
import { describe, test, expect } from 'bun:test';
import { resolveModules } from 'pyric/rules/node';
import { makeRoot, runOp } from './_helpers.js';

const SOURCE = `import { isAuthenticated } from 'auth';
import { fieldUnchanged } from 'lifecycle';
import { hasRequired, hasOnly } from 'validation';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {

    match /accounts/{accountId} {
      allow read: if isAuthenticated()
          && resource.data.ownerId == request.auth.uid;
      allow create: if isAuthenticated()
          && request.resource.data.ownerId == request.auth.uid
          && hasRequired(['ownerId', 'name', 'balance']);
      allow update: if isAuthenticated()
          && resource.data.ownerId == request.auth.uid
          && fieldUnchanged('ownerId')
          && fieldUnchanged('balance')
          && hasOnly(['ownerId', 'name', 'balance']);
      allow delete: if false;
    }

    match /transfers/{transferId} {
      allow read: if isAuthenticated()
          && (resource.data.senderId == request.auth.uid
              || resource.data.receiverId == request.auth.uid);

      allow create: if isAuthenticated()
          && request.resource.data.senderId == request.auth.uid
          && request.resource.data.senderId != request.resource.data.receiverId
          && request.resource.data.amount > 0
          && request.resource.data.status == 'pending'
          && hasRequired(['senderId', 'receiverId', 'amount', 'senderAccountId', 'receiverAccountId', 'status'])
          && get(/databases/$(database)/documents/accounts/$(request.resource.data.senderAccountId)).data.balance >= request.resource.data.amount
          && get(/databases/$(database)/documents/accounts/$(request.resource.data.senderAccountId)).data.ownerId == request.auth.uid
          && exists(/databases/$(database)/documents/accounts/$(request.resource.data.receiverAccountId));

      allow update: if false;
      allow delete: if false;
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

const SEED = {
  'accounts/a1': { ownerId: 'alice', name: 'Checking', balance: 1000 },
  'accounts/a2': { ownerId: 'bob', name: 'Savings', balance: 500 },
  'accounts/a3': { ownerId: 'alice', name: 'Savings', balance: 200 },
  'transfers/tx1': { senderId: 'alice', receiverId: 'bob', amount: 100, senderAccountId: 'a1', receiverAccountId: 'a2', status: 'pending' },
};

describe('Scenario 13: Financial Transfer', () => {
  // ═══ ALLOW ═══

  test('create transfer with sufficient balance', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transfers/tx2', auth: { uid: 'alice' }, data: { senderId: 'alice', receiverId: 'bob', amount: 500, senderAccountId: 'a1', receiverAccountId: 'a2', status: 'pending' } });
    expect(r.allowed).toBe(true);
  });

  test('create transfer with exact balance', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transfers/tx3', auth: { uid: 'alice' }, data: { senderId: 'alice', receiverId: 'bob', amount: 1000, senderAccountId: 'a1', receiverAccountId: 'a2', status: 'pending' } });
    expect(r.allowed).toBe(true);
  });

  test('reverse transfer (bob to alice)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transfers/tx4', auth: { uid: 'bob' }, data: { senderId: 'bob', receiverId: 'alice', amount: 100, senderAccountId: 'a2', receiverAccountId: 'a1', status: 'pending' } });
    expect(r.allowed).toBe(true);
  });

  test('create account', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'accounts/a4', auth: { uid: 'carol' }, data: { ownerId: 'carol', name: 'New Account', balance: 0 } });
    expect(r.allowed).toBe(true);
  });

  test('update account name', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'accounts/a1', auth: { uid: 'alice' }, data: { name: 'Primary Checking' } });
    expect(r.allowed).toBe(true);
  });

  // ═══ DENY ═══

  test('insufficient balance denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transfers/tx5', auth: { uid: 'alice' }, data: { senderId: 'alice', receiverId: 'bob', amount: 1001, senderAccountId: 'a1', receiverAccountId: 'a2', status: 'pending' } });
    expect(r.allowed).toBe(false);
  });

  test('zero amount denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transfers/tx6', auth: { uid: 'alice' }, data: { senderId: 'alice', receiverId: 'bob', amount: 0, senderAccountId: 'a1', receiverAccountId: 'a2', status: 'pending' } });
    expect(r.allowed).toBe(false);
  });

  test('delete account blocked', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'accounts/a1', auth: { uid: 'alice' } });
    expect(r.allowed).toBe(false);
  });

  test('update transfer blocked', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'transfers/tx1', auth: { uid: 'alice' }, data: { amount: 999 } });
    expect(r.allowed).toBe(false);
  });

  test('spoofed sender denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transfers/tx7', auth: { uid: 'alice' }, data: { senderId: 'bob', receiverId: 'alice', amount: 100, senderAccountId: 'a2', receiverAccountId: 'a1', status: 'pending' } });
    expect(r.allowed).toBe(false);
  });

  test('self-transfer denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transfers/tx8', auth: { uid: 'alice' }, data: { senderId: 'alice', receiverId: 'alice', amount: 100, senderAccountId: 'a1', receiverAccountId: 'a3', status: 'pending' } });
    expect(r.allowed).toBe(false);
  });

  test('unowned account denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transfers/tx9', auth: { uid: 'alice' }, data: { senderId: 'alice', receiverId: 'bob', amount: 100, senderAccountId: 'a2', receiverAccountId: 'a1', status: 'pending' } });
    expect(r.allowed).toBe(false);
  });

  test('non-existent receiver account denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transfers/tx10', auth: { uid: 'alice' }, data: { senderId: 'alice', receiverId: 'bob', amount: 100, senderAccountId: 'a1', receiverAccountId: 'a999', status: 'pending' } });
    expect(r.allowed).toBe(false);
  });

  test('negative amount denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transfers/tx11', auth: { uid: 'alice' }, data: { senderId: 'alice', receiverId: 'bob', amount: -50, senderAccountId: 'a1', receiverAccountId: 'a2', status: 'pending' } });
    expect(r.allowed).toBe(false);
  });

  test('direct balance update denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'accounts/a1', auth: { uid: 'alice' }, data: { balance: 999999 } });
    expect(r.allowed).toBe(false);
  });

  test('non-pending status denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'transfers/tx12', auth: { uid: 'alice' }, data: { senderId: 'alice', receiverId: 'bob', amount: 100, senderAccountId: 'a1', receiverAccountId: 'a2', status: 'completed' } });
    expect(r.allowed).toBe(false);
  });
});
