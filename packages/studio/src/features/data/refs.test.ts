/**
 * Unit tests for the cross-reference detector (F2). Run: `bun test`.
 *
 * The detector is the load-bearing piece of the clickable-references feature:
 * a false positive turns an ordinary string into a broken link, so these tests
 * pin the precedence + the conservative boundaries.
 */
import { describe, expect, test } from 'bun:test';
import { describeRef, detectRef, isCrossRef } from './refs.js';

describe('detectRef: non-strings', () => {
  test('numbers, booleans, null, objects are plain', () => {
    expect(detectRef(42).kind).toBe('plain');
    expect(detectRef(true).kind).toBe('plain');
    expect(detectRef(null).kind).toBe('plain');
    expect(detectRef({ a: 1 }).kind).toBe('plain');
    expect(detectRef([1, 2]).kind).toBe('plain');
  });

  test('object plain ref serialises for display', () => {
    expect(detectRef({ a: 1 }).raw).toBe('{"a":1}');
    expect(detectRef(null).raw).toBe('null');
  });

  test('empty / whitespace string is plain', () => {
    expect(detectRef('').kind).toBe('plain');
    expect(detectRef('   ').kind).toBe('plain');
  });
});

describe('detectRef: gs:// storage (structural, key-independent)', () => {
  test('parses bucket + object path', () => {
    const ref = detectRef('gs://my-bucket/avatars/alice.png');
    expect(ref).toEqual({
      kind: 'storage',
      bucket: 'my-bucket',
      objectPath: 'avatars/alice.png',
      raw: 'gs://my-bucket/avatars/alice.png',
    });
  });

  test('gs:// wins even with a uid-ish field name', () => {
    const ref = detectRef('gs://b/x.png', { fieldKey: 'ownerUid' });
    expect(ref.kind).toBe('storage');
  });

  test('trims slashes in the object path', () => {
    const ref = detectRef('gs://b/a/b/');
    expect(ref.kind === 'storage' && ref.objectPath).toBe('a/b');
  });

  test('gs:// with no object path is not a storage ref', () => {
    expect(detectRef('gs://just-bucket').kind).not.toBe('storage');
  });
});

describe('detectRef: Auth users', () => {
  test('known uid membership is authoritative regardless of field name', () => {
    const knownUids = new Set(['abc123', 'alice']);
    expect(detectRef('alice', { knownUids }).kind).toBe('user');
    expect(detectRef('abc123', { fieldKey: 'note', knownUids }).kind).toBe('user');
  });

  test('uid-ish field name + uid-shaped value links', () => {
    expect(detectRef('Xk29ffQ', { fieldKey: 'ownerUid' }).kind).toBe('user');
    expect(detectRef('user-7', { fieldKey: 'userId' }).kind).toBe('user');
    expect(detectRef('u1', { fieldKey: 'createdBy' }).kind).toBe('user');
  });

  test('uid-ish keys across camel/snake/kebab casings', () => {
    expect(detectRef('u1', { fieldKey: 'owner_uid' }).kind).toBe('user');
    expect(detectRef('u1', { fieldKey: 'owner-uid' }).kind).toBe('user');
    expect(detectRef('u1', { fieldKey: 'memberId' }).kind).toBe('user');
    expect(detectRef('u1', { fieldKey: 'assigneeRef' }).kind).toBe('user');
    expect(detectRef('u1', { fieldKey: 'uid' }).kind).toBe('user');
  });

  test('non-person id keys do NOT become user refs (no false positive)', () => {
    expect(detectRef('p1', { fieldKey: 'productId' }).kind).toBe('plain');
    expect(detectRef('o1', { fieldKey: 'orderId' }).kind).toBe('plain');
    expect(detectRef('t1', { fieldKey: 'tenantId' }).kind).toBe('plain');
  });

  test('uid-shaped value WITHOUT a uid-ish key or membership stays plain', () => {
    // Conservative: not every id-shaped token becomes a user link.
    expect(detectRef('Xk29ffQ').kind).toBe('plain');
    expect(detectRef('Xk29ffQ', { fieldKey: 'title' }).kind).toBe('plain');
  });

  test('uid-ish key but value too path-like is not a user', () => {
    // A slash disqualifies the uid shape.
    const ref = detectRef('users/alice', { fieldKey: 'ownerUid' });
    expect(ref.kind).not.toBe('user');
  });

  test('real 28-char Firebase-style uid with a uid key', () => {
    const uid = 'aZ09bYx8cWv7dUt6eSr5fQp4nMl3';
    expect(uid).toHaveLength(28);
    expect(detectRef(uid, { fieldKey: 'authorId' }).kind).toBe('user');
  });
});

describe('detectRef: Firestore document paths', () => {
  test('even-segment path is a document ref', () => {
    expect(detectRef('users/alice').kind).toBe('document');
    expect(detectRef('users/alice/posts/p1').kind).toBe('document');
  });

  test('odd-segment path (a collection) is NOT a document ref', () => {
    expect(detectRef('users').kind).toBe('plain');
    expect(detectRef('users/alice/posts').kind).toBe('plain');
  });

  test('normalises leading/trailing slashes', () => {
    const ref = detectRef('/users/alice/');
    expect(ref.kind === 'document' && ref.path).toBe('users/alice');
  });

  test('a URL is never a document ref', () => {
    expect(detectRef('https://example.com/a/b').kind).toBe('plain');
  });

  test('segments with dots (likely filenames/hosts) are not doc paths', () => {
    expect(detectRef('files/a.png').kind).toBe('plain');
  });
});

describe('detectRef: bare storage paths via field name', () => {
  test('storage-ish key + bare path → storage ref (no bucket)', () => {
    const ref = detectRef('avatars/alice.png', { fieldKey: 'avatar' });
    expect(ref).toMatchObject({ kind: 'storage', bucket: null, objectPath: 'avatars/alice.png' });
  });

  test('storage-ish key but value with no slash stays plain', () => {
    expect(detectRef('alice.png', { fieldKey: 'photo' }).kind).toBe('plain');
  });

  test('precedence: known-uid beats a storage-ish key', () => {
    const ref = detectRef('a/b', { fieldKey: 'imageUid', knownUids: new Set(['a/b']) });
    // 'a/b' is not uid-shaped, so membership still wins via the structural set.
    expect(ref.kind).toBe('user');
  });
});

describe('isCrossRef + describeRef', () => {
  test('isCrossRef is false only for plain', () => {
    expect(isCrossRef(detectRef('hello'))).toBe(false);
    expect(isCrossRef(detectRef('gs://b/x'))).toBe(true);
    expect(isCrossRef(detectRef('users/alice'))).toBe(true);
  });

  test('describeRef produces readable labels', () => {
    expect(describeRef(detectRef('gs://b/x.png'))).toBe('gs://b/x.png');
    expect(describeRef(detectRef('users/alice'))).toBe('users/alice');
    expect(describeRef(detectRef('u1', { knownUids: new Set(['u1']) }))).toBe('user · u1');
    expect(describeRef(detectRef('plain text'))).toBe('plain text');
  });
});
