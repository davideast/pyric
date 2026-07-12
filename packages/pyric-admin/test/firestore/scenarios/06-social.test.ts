/**
 * Scenario 6: Social Profile with Privacy
 *
 * Public/private profiles, follower relationships with compound IDs,
 * exists() for follower checks, self-follow prevention.
 * Stdlib: auth, lifecycle
 *
 * Rules: inline
 *
 * Migrated through `pyric/sandbox` — operations dispatch through
 * `getFirestore(sandbox)` instead of `LocalEnvironment.execute`.
 */
import { describe, test, expect } from 'bun:test';
import { resolveModules } from 'pyric/rules/internal/node';
import { makeRoot, runOp } from './_helpers.js';

const SOURCE = `import { isAuthenticated } from 'auth';
import { fieldUnchanged } from 'lifecycle';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /profiles/{uid} {
      allow read: if true;
      allow create: if isAuthenticated()
          && request.auth.uid == uid
          && request.resource.data.displayName != '';
      allow update: if isAuthenticated()
          && request.auth.uid == uid
          && request.resource.data.displayName != '';
      allow delete: if isAuthenticated()
          && request.auth.uid == uid;
    }
    match /follows/{followId} {
      allow create: if isAuthenticated()
          && request.resource.data.followerId == request.auth.uid
          && request.resource.data.followerId != request.resource.data.followeeId
          && followId == (request.resource.data.followerId + '_' + request.resource.data.followeeId);
      allow update: if false;
      allow delete: if isAuthenticated()
          && resource.data.followerId == request.auth.uid;
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

const SEED = {
  'profiles/alice': { displayName: 'Alice', bio: 'Hello' },
  'profiles/bob': { displayName: 'Bob', bio: 'Hi' },
  'follows/alice_bob': { followerId: 'alice', followeeId: 'bob' },
};

describe('Scenario 6: Social Profile with Privacy', () => {
  test('create own profile', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'profiles/carol', auth: { uid: 'carol' }, data: { displayName: 'Carol', bio: 'Hey' } });
    expect(r.allowed).toBe(true);
  });

  test('update own profile', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'profiles/alice', auth: { uid: 'alice' }, data: { displayName: 'Alice A', bio: 'Updated' } });
    expect(r.allowed).toBe(true);
  });

  test('create follow', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'follows/bob_alice', auth: { uid: 'bob' }, data: { followerId: 'bob', followeeId: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('unfollow (delete)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'follows/alice_bob', auth: { uid: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('delete own profile', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'profiles/alice', auth: { uid: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('cannot create profile for others', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'profiles/carol', auth: { uid: 'alice' }, data: { displayName: 'Carol', bio: 'Fake' } });
    expect(r.allowed).toBe(false);
  });

  test('cannot update others profile', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'profiles/bob', auth: { uid: 'alice' }, data: { displayName: 'Hacked', bio: 'Hacked' } });
    expect(r.allowed).toBe(false);
  });

  test('empty displayName denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'profiles/carol', auth: { uid: 'carol' }, data: { displayName: '', bio: 'Hey' } });
    expect(r.allowed).toBe(false);
  });

  test('self-follow denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'follows/alice_alice', auth: { uid: 'alice' }, data: { followerId: 'alice', followeeId: 'alice' } });
    expect(r.allowed).toBe(false);
  });

  test('spoof followerId denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'follows/bob_alice', auth: { uid: 'alice' }, data: { followerId: 'bob', followeeId: 'alice' } });
    expect(r.allowed).toBe(false);
  });

  test('non-follower cannot unfollow', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'follows/alice_bob', auth: { uid: 'bob' } });
    expect(r.allowed).toBe(false);
  });

  test('follow update blocked', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'follows/alice_bob', auth: { uid: 'alice' }, data: { followerId: 'alice', followeeId: 'carol' } });
    expect(r.allowed).toBe(false);
  });
});
