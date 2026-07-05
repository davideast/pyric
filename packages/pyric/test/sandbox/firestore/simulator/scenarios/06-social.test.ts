/**
 * Scenario 6: Social Profile with Privacy
 *
 * Public/private profiles, follower relationships with compound IDs,
 * exists() for follower checks, self-follow prevention.
 * Stdlib: auth, lifecycle
 *
 * Rules: inline
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { resolveModules } from 'pyric/rules/node';

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

describe('Scenario 6: Social Profile with Privacy', () => {
  function makeEnv() {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES,
      documents: {
        'profiles/alice': { displayName: 'Alice', bio: 'Hello' },
        'profiles/bob': { displayName: 'Bob', bio: 'Hi' },
        'follows/alice_bob': { followerId: 'alice', followeeId: 'bob' },
      },
    });
    return env;
  }

  test('create own profile', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'profiles/carol', auth: { uid: 'carol' }, data: { displayName: 'Carol', bio: 'Hey' } });
    expect(r.allowed).toBe(true);
  });

  test('update own profile', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'profiles/alice', auth: { uid: 'alice' }, data: { displayName: 'Alice A', bio: 'Updated' } });
    expect(r.allowed).toBe(true);
  });

  test('create follow', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'follows/bob_alice', auth: { uid: 'bob' }, data: { followerId: 'bob', followeeId: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('unfollow (delete)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'delete', path: 'follows/alice_bob', auth: { uid: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('delete own profile', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'delete', path: 'profiles/alice', auth: { uid: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('cannot create profile for others', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'profiles/carol', auth: { uid: 'alice' }, data: { displayName: 'Carol', bio: 'Fake' } });
    expect(r.allowed).toBe(false);
  });

  test('cannot update others profile', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'profiles/bob', auth: { uid: 'alice' }, data: { displayName: 'Hacked', bio: 'Hacked' } });
    expect(r.allowed).toBe(false);
  });

  test('empty displayName denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'profiles/carol', auth: { uid: 'carol' }, data: { displayName: '', bio: 'Hey' } });
    expect(r.allowed).toBe(false);
  });

  test('self-follow denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'follows/alice_alice', auth: { uid: 'alice' }, data: { followerId: 'alice', followeeId: 'alice' } });
    expect(r.allowed).toBe(false);
  });

  test('spoof followerId denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'follows/bob_alice', auth: { uid: 'alice' }, data: { followerId: 'bob', followeeId: 'alice' } });
    expect(r.allowed).toBe(false);
  });

  test('non-follower cannot unfollow', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'delete', path: 'follows/alice_bob', auth: { uid: 'bob' } });
    expect(r.allowed).toBe(false);
  });

  test('follow update blocked', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'follows/alice_bob', auth: { uid: 'alice' }, data: { followerId: 'alice', followeeId: 'carol' } });
    expect(r.allowed).toBe(false);
  });
});
