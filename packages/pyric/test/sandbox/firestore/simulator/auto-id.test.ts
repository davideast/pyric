/**
 * Item 7 — Firestore-compatible auto document IDs.
 *
 * Test contract:
 *   - 1000 generated IDs are all 20 chars / alphanumeric / unique.
 *   - `LocalEnvironment.createWithAutoId(collection, data, auth)` mints a
 *     valid ID, returns the full path, and the doc is readable via
 *     `getDocument(returnedPath)`.
 *   - Rules see the full minted path (so per-doc rules with wildcards work).
 */
import { describe, test, expect } from 'bun:test';
import {
  generateAutoId,
  FIRESTORE_AUTO_ID_LENGTH,
  FIRESTORE_AUTO_ID_ALPHABET,
} from 'pyric/sandbox/internal';
import { LocalEnvironment } from 'pyric/sandbox/internal';

const OPEN_RULES =
  "rules_version = '2'; service cloud.firestore {" +
  '  match /databases/{database}/documents {' +
  '    match /{document=**} { allow read, write: if true; }' +
  '  }' +
  '}';

// ─── generateAutoId ────────────────────────────────────────────────────────

describe('generateAutoId', () => {
  test('exposes the canonical Firestore alphabet and length', () => {
    expect(FIRESTORE_AUTO_ID_LENGTH).toBe(20);
    expect(FIRESTORE_AUTO_ID_ALPHABET).toBe(
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    );
    expect(FIRESTORE_AUTO_ID_ALPHABET.length).toBe(62);
  });

  test('produces a 20-character alphanumeric ID', () => {
    const id = generateAutoId();
    expect(id).toHaveLength(20);
    expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
  });

  test('1000 samples: every ID is 20 chars, alphanumeric, and unique', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = generateAutoId();
      expect(id).toHaveLength(20);
      expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
      ids.add(id);
    }
    // Collision-free at 1000 samples — ~119 bits of entropy makes the
    // birthday-bound expectation effectively zero.
    expect(ids.size).toBe(1000);
  });
});

// ─── LocalEnvironment.createWithAutoId ─────────────────────────────────────

describe('LocalEnvironment.createWithAutoId', () => {
  test('returns the minted path and writes the doc', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: {} });
    const { path, result } = env.createWithAutoId(
      'users',
      { name: 'A' },
      { uid: 'u1' },
    );
    expect(result.allowed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(path).toMatch(/^users\/[A-Za-z0-9]{20}$/);
    expect(env.getDocument(path)).toEqual({ name: 'A' });
  });

  test('handles a trailing slash in the collection arg', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: {} });
    const { path } = env.createWithAutoId(
      'users/',
      { name: 'B' },
      { uid: 'u1' },
    );
    expect(path).toMatch(/^users\/[A-Za-z0-9]{20}$/);
    expect(path.includes('//')).toBe(false);
  });

  test('works for nested subcollections', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: {} });
    const { path, result } = env.createWithAutoId(
      'users/u1/posts',
      { body: 'hi' },
      { uid: 'u1' },
    );
    expect(result.allowed).toBe(true);
    expect(path).toMatch(/^users\/u1\/posts\/[A-Za-z0-9]{20}$/);
    expect(env.getDocument(path)).toEqual({ body: 'hi' });
  });

  test('every call mints a fresh ID — 100 inserts produce 100 docs', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: OPEN_RULES, documents: {} });
    const paths = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { path, result } = env.createWithAutoId(
        'items',
        { i },
        { uid: 'u1' },
      );
      expect(result.allowed).toBe(true);
      paths.add(path);
    }
    expect(paths.size).toBe(100);
    // Listing the collection should see every minted doc.
    const listed = env.listDocuments('items');
    expect(listed.length).toBe(100);
  });

  test('rules evaluate against the full minted path (per-doc wildcards work)', () => {
    // Rule allows writes only to `users/{userId}` where userId == auth.uid.
    // Auto-ID create should be denied because the minted ID won't equal
    // the auth uid — proving the rule sees the real path, not a stub.
    const env = new LocalEnvironment();
    env.seed({
      rules:
        "rules_version = '2'; service cloud.firestore {" +
        '  match /databases/{database}/documents {' +
        '    match /users/{userId} {' +
        '      allow create: if request.auth.uid == userId;' +
        '    }' +
        '  }' +
        '}',
      documents: {},
    });
    const { path, result } = env.createWithAutoId(
      'users',
      { name: 'X' },
      { uid: 'u1' },
    );
    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe('permission-denied');
    expect(env.getDocument(path)).toBeNull();
  });

  test('a denied auto-id create surfaces the minted path on the failed result', () => {
    // Even on denial we want the minted path back so a caller can log
    // exactly which doc the simulator attempted to create.
    const env = new LocalEnvironment();
    env.seed({
      rules:
        "rules_version = '2'; service cloud.firestore {" +
        '  match /databases/{database}/documents {' +
        '    match /{document=**} { allow read, write: if false; }' +
        '  }' +
        '}',
      documents: {},
    });
    const { path, result } = env.createWithAutoId(
      'denied',
      { x: 1 },
      { uid: 'u1' },
    );
    expect(result.allowed).toBe(false);
    expect(path).toMatch(/^denied\/[A-Za-z0-9]{20}$/);
    expect(env.getDocument(path)).toBeNull();
  });
});
