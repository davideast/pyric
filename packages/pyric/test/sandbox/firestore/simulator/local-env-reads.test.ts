/**
 * TDD tests for LocalEnvironment rules-evaluated reads.
 *
 * Previously, env.execute({ method: 'get' }) bypassed rules and returned
 * data as admin. Now reads flow through the simulator like writes.
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';

// ═══ Rules with various read patterns ═══

const MULTI_COLLECTION_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /public/{docId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
    match /private/{docId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null;
    }
    match /users/{userId} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow create: if request.auth != null && request.auth.uid == userId;
    }
    match /admin/{docId} {
      allow read: if request.auth != null && request.auth.token.role == 'admin';
      allow write: if request.auth != null && request.auth.token.role == 'admin';
    }
    match /locked/{docId} {
      allow read: if false;
      allow write: if false;
    }
    match /items/{docId} {
      allow read: if request.auth != null;
      allow list: if request.auth != null;
      allow write: if request.auth != null;
    }
    match /profiles/{uid} {
      allow read: if resource.data.isPublic == true
          || (request.auth != null && request.auth.uid == uid)
          || (request.auth != null
              && exists(/databases/$(database)/documents/follows/$(request.auth.uid + '_' + uid)));
      allow write: if request.auth != null && request.auth.uid == uid;
    }
    match /follows/{followId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}`;

function makeEnv() {
  const env = new LocalEnvironment();
  env.seed({
    rules: MULTI_COLLECTION_RULES,
    documents: {
      'public/doc1': { title: 'Public' },
      'private/doc1': { secret: 'data' },
      'users/alice': { name: 'Alice', email: 'alice@test.com' },
      'users/bob': { name: 'Bob', email: 'bob@test.com' },
      'admin/doc1': { config: 'sensitive' },
      'locked/doc1': { secret: 'data' },
      'items/i1': { name: 'Widget' },
      'items/i2': { name: 'Gadget' },
      'profiles/bob': { displayName: 'Bob', isPublic: false },
      'profiles/carol': { displayName: 'Carol', isPublic: true },
      'follows/alice_bob': { followerId: 'alice', followeeId: 'bob' },
    },
  });
  return env;
}

describe('LocalEnvironment rules-evaluated reads', () => {

  // ═══ Test 1: Public doc allowed ═══
  test('public doc readable by anyone', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'get', path: 'public/doc1', auth: { uid: 'anyone' } });
    expect(r.allowed).toBe(true);
    expect(r.data).toEqual({ title: 'Public' });
  });

  // ═══ Test 2: Unauthenticated denied on private ═══
  test('unauthenticated denied on private collection', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'get', path: 'private/doc1', auth: null });
    expect(r.allowed).toBe(false);
  });

  // ═══ Test 3: Owner-only access ═══
  test('owner can read own user doc', () => {
    const env = makeEnv();
    expect(env.execute({ method: 'get', path: 'users/alice', auth: { uid: 'alice' } }).allowed).toBe(true);
  });

  test('non-owner denied from user doc', () => {
    const env = makeEnv();
    expect(env.execute({ method: 'get', path: 'users/alice', auth: { uid: 'bob' } }).allowed).toBe(false);
  });

  // ═══ Test 4: Non-existent doc ═══
  test('non-existent doc — rules checking resource fields deny', () => {
    const env = makeEnv();
    // users/{userId} rule checks request.auth.uid == userId — should still work
    // but resource.data will be null for non-existent docs
    const r = env.execute({ method: 'get', path: 'users/nobody', auth: { uid: 'nobody' } });
    // The rule `request.auth.uid == userId` doesn't depend on resource.data, so this should ALLOW
    expect(r.allowed).toBe(true);
  });

  // ═══ Test 5: Conditional access with exists() ═══
  test('follower can read private profile', () => {
    const env = makeEnv();
    // alice follows bob (follows/alice_bob exists)
    expect(env.execute({ method: 'get', path: 'profiles/bob', auth: { uid: 'alice' } }).allowed).toBe(true);
  });

  test('non-follower denied from private profile', () => {
    const env = makeEnv();
    expect(env.execute({ method: 'get', path: 'profiles/bob', auth: { uid: 'stranger' } }).allowed).toBe(false);
  });

  test('public profile readable by anyone', () => {
    const env = makeEnv();
    expect(env.execute({ method: 'get', path: 'profiles/carol', auth: { uid: 'stranger' } }).allowed).toBe(true);
  });

  // ═══ Test 6: List operation ═══
  // Note: Firestore list rules are defined at the document match level (items/{docId})
  // but list operations target the collection. The simulator matches list paths
  // against document-level match blocks by appending a placeholder segment.
  test('authenticated user can list items', () => {
    const env = makeEnv();
    // Use a document-level path since list rules are evaluated at that level
    expect(env.execute({ method: 'list', path: 'items/placeholder', auth: { uid: 'user1' } }).allowed).toBe(true);
  });

  test('unauthenticated cannot list items', () => {
    const env = makeEnv();
    expect(env.execute({ method: 'list', path: 'items/placeholder', auth: null }).allowed).toBe(false);
  });

  // ═══ Test 7: Denied read logged in event log ═══
  test('denied read is logged in event log', () => {
    const env = makeEnv();
    env.execute({ method: 'get', path: 'private/doc1', auth: null });
    const events = env.getEvents();
    expect(events.length).toBe(1);
    expect(events[0].method).toBe('get');
    expect(events[0].allowed).toBe(false);
  });

  // ═══ Test 8: Custom claims ═══
  test('admin claim allows read', () => {
    const env = makeEnv();
    expect(env.execute({ method: 'get', path: 'admin/doc1', auth: { uid: 'u1', token: { role: 'admin' } } }).allowed).toBe(true);
  });

  test('missing admin claim denied', () => {
    const env = makeEnv();
    expect(env.execute({ method: 'get', path: 'admin/doc1', auth: { uid: 'u1', token: {} } }).allowed).toBe(false);
  });

  // ═══ Test 9: Admin read (getDocument) still bypasses ═══
  test('getDocument still bypasses rules (admin read)', () => {
    const env = makeEnv();
    // locked/doc1 has allow read: if false — but getDocument is admin
    expect(env.getDocument('locked/doc1')).toEqual({ secret: 'data' });
  });

  // ═══ Test 10: Allowed read returns data ═══
  test('allowed read returns document data', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'get', path: 'public/doc1', auth: { uid: 'u1' } });
    expect(r.allowed).toBe(true);
    expect(r.data).toEqual({ title: 'Public' });
  });

  // ═══ Test 11: Denied read returns no data ═══
  test('denied read returns undefined data', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'get', path: 'private/doc1', auth: null });
    expect(r.allowed).toBe(false);
    expect(r.data).toBeUndefined();
  });

  // ═══ Test 12: Debug messages on denied read ═══
  test('denied read has debug messages', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'get', path: 'private/doc1', auth: null });
    expect(r.debugMessages.length).toBeGreaterThan(0);
  });
});
