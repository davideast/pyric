/**
 * Item 3 — DocumentReference converter + LocalEnvironment parity tests.
 *
 * Plan section Item 3 test contract:
 *   - Seed `{ author: refToUsersU1 }`; rule
 *     `resource.data.author is reference` returns true.
 *   - `resource.data.author.path == 'users/u1'` evaluates correctly.
 *   - Schema discovery on the seeded data reports
 *     `kind: 'reference', targetCollection: 'users'`.
 *
 * Plus direct converter unit tests (KEEP / idempotency / duck-type
 * boundary) matching the timestamp.test.ts shape.
 */
import { describe, test, expect } from 'bun:test';
import { documentReferenceConverter } from 'pyric/sandbox/internal';
import { Reference } from 'pyric/rules/internal';
import { KEEP } from 'pyric/sandbox/internal';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { encodeValue } from 'pyric/sandbox/internal';
import { wireValueToFieldType } from '@pyric/cli/internal/discover';

const baseCtx = (
  overrides: Partial<{
    path: string;
    method: 'create' | 'update' | 'set' | 'seed';
    prior: Record<string, unknown> | null;
    fieldPath: string;
    serverTime: unknown;
  }> = {},
) => ({
  path: 'p/x',
  method: 'create' as const,
  prior: null,
  fieldPath: 'author',
  ...overrides,
});

/** Build a duck-typed admin SDK DocumentReference for converter tests. */
function fakeAdminRef(relativePath: string): unknown {
  return {
    path: relativePath,
    id: relativePath.split('/').pop() ?? '',
    _path: { segments: relativePath.split('/') },
    _firestore: {},
  };
}

// ─── Converter unit tests ──────────────────────────────────────────────────

describe('documentReferenceConverter', () => {
  test('wraps an admin-SDK DocumentReference into our Reference', () => {
    const out = documentReferenceConverter.convert(fakeAdminRef('users/u1'), baseCtx());
    expect(out).toBeInstanceOf(Reference);
    expect((out as Reference).path).toBe('users/u1');
  });

  test('idempotent: a Reference wrapper on a second pass declines', () => {
    const ref = new Reference('users/u1');
    expect(documentReferenceConverter.convert(ref, baseCtx())).toBe(KEEP);
  });

  test('declines plain values', () => {
    expect(documentReferenceConverter.convert('users/u1', baseCtx())).toBe(KEEP);
    expect(documentReferenceConverter.convert(42, baseCtx())).toBe(KEEP);
    expect(documentReferenceConverter.convert(null, baseCtx())).toBe(KEEP);
    expect(documentReferenceConverter.convert({ a: 1 }, baseCtx())).toBe(KEEP);
  });

  test('declines plain objects that lack the admin private members', () => {
    // Has path/id but no _path or _firestore — looks like a normal map,
    // not an admin SDK ref. Must not be claimed.
    expect(
      documentReferenceConverter.convert(
        { path: 'users/u1', id: 'u1' },
        baseCtx(),
      ),
    ).toBe(KEEP);
  });
});

// ─── Wire encoding ─────────────────────────────────────────────────────────

describe('wire-encoder — Reference', () => {
  test('encodes Reference as referenceValue with full resource name', () => {
    const out = encodeValue(new Reference('users/u1'));
    expect(out).toEqual({
      referenceValue: 'projects/sim/databases/(default)/documents/users/u1',
    });
  });

  test('discover/wire.ts decodes our referenceValue to kind:reference', () => {
    const wire = encodeValue(new Reference('users/u1'));
    const ft = wireValueToFieldType(wire);
    expect(ft).toEqual({ kind: 'reference', targetCollection: 'users' });
  });

  test('schema discovery on a nested ref reports the full target collection', () => {
    const wire = encodeValue(new Reference('users/u1/posts/p1'));
    const ft = wireValueToFieldType(wire);
    // parseRefTargetCollectionPath drops the trailing doc id, leaving
    // the full collection path.
    expect(ft).toEqual({ kind: 'reference', targetCollection: 'users/u1/posts' });
  });
});

// ─── LocalEnvironment + rules integration ────────────────────────────────

describe('LocalEnvironment — reference rules', () => {
  function envAllowingIfReference() {
    const env = new LocalEnvironment();
    env.seed({
      rules:
        "rules_version = '2'; service cloud.firestore {" +
        '  match /databases/{database}/documents {' +
        '    match /posts/{p} {' +
        '      allow create: if request.resource.data.author is reference;' +
        '      allow read: if true;' +
        '    }' +
        '  }' +
        '}',
      documents: {},
    });
    return env;
  }

  test('write with admin-SDK DocumentReference passes `is reference`', () => {
    const env = envAllowingIfReference();
    const r = env.execute({
      method: 'create',
      path: 'posts/p1',
      auth: { uid: 'u1' },
      data: { author: fakeAdminRef('users/u1') },
    });
    expect(r.allowed).toBe(true);
    // Stored as our Reference wrapper, not the raw admin object.
    const stored = env.getDocument('posts/p1');
    expect(stored?.['author']).toBeInstanceOf(Reference);
    expect((stored?.['author'] as Reference).path).toBe('users/u1');
  });

  test('write with our Reference wrapper directly also passes `is reference`', () => {
    const env = envAllowingIfReference();
    const r = env.execute({
      method: 'create',
      path: 'posts/p1',
      auth: { uid: 'u1' },
      data: { author: new Reference('users/u1') },
    });
    expect(r.allowed).toBe(true);
  });

  test('rule comparing ref.path to a literal evaluates correctly', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules:
        "rules_version = '2'; service cloud.firestore {" +
        '  match /databases/{database}/documents {' +
        '    match /posts/{p} {' +
        // The author must be the user creating the doc.
        '      allow create: if request.resource.data.author.path == "users/" + request.auth.uid;' +
        '    }' +
        '  }' +
        '}',
      documents: {},
    });

    // Allowed: matching uid.
    const ok = env.execute({
      method: 'create',
      path: 'posts/p1',
      auth: { uid: 'u1' },
      data: { author: new Reference('users/u1') },
    });
    expect(ok.allowed).toBe(true);

    // Denied: mismatched uid.
    const bad = env.execute({
      method: 'create',
      path: 'posts/p2',
      auth: { uid: 'u1' },
      data: { author: new Reference('users/u2') },
    });
    expect(bad.allowed).toBe(false);
  });

  test('seeded reference is preserved as a Reference instance', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: "rules_version = '2'; service cloud.firestore {" +
        '  match /databases/{database}/documents {' +
        '    match /{document=**} { allow read, write: if true; }' +
        '  }' +
        '}',
      documents: { 'posts/p1': { author: new Reference('users/u1') } },
    });
    const stored = env.getDocument('posts/p1');
    expect(stored?.['author']).toBeInstanceOf(Reference);
    expect((stored?.['author'] as Reference).path).toBe('users/u1');
  });
});
