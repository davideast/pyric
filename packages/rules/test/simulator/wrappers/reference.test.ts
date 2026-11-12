/**
 * Reference wrapper unit tests — Item 3 contract for the rules-side
 * surface. Concrete admin-SDK conversion lives in
 * converters/reference.test.ts; LocalEnvironment+rules integration
 * lives in this same Item's end-to-end suite.
 */
import { describe, test, expect } from 'bun:test';
import { firestoreRules, reference } from '../../../src/index.js';
import { Path } from '../../../src/simulator/wrappers/path.js';
import { Reference, referenceToResourceName } from '../../../src/simulator/wrappers/reference.js';

describe('Reference wrapper', () => {
  test('typeName is "reference" — drives `is reference` dispatch', () => {
    expect(new Reference('users/u1').typeName).toBe('reference');
  });

  test('.path is the relative document path', () => {
    expect(new Reference('users/u1').path).toBe('users/u1');
    expect(new Reference('users/u1/posts/p1').path).toBe('users/u1/posts/p1');
  });

  test('.id returns the last segment', () => {
    expect(new Reference('users/u1').id).toBe('u1');
    expect(new Reference('users/u1/posts/p1').id).toBe('p1');
  });

  test('.parent returns the parent collection path string', () => {
    expect(new Reference('users/u1').parent).toBe('users');
    expect(new Reference('users/u1/posts/p1').parent).toBe('users/u1/posts');
  });

  test('field() routes .path/.id/.parent and returns null for unknown', () => {
    const r = new Reference('users/u1');
    expect(r.field('path')).toBe('users/u1');
    expect(r.field('id')).toBe('u1');
    expect(r.field('parent')).toBe('users');
    expect(r.field('firestore')).toBeNull();
    expect(r.field('anything')).toBeNull();
  });

  test('toString() returns the relative path (matches admin SDK shape)', () => {
    expect(String(new Reference('users/u1'))).toBe('users/u1');
  });

  test('valueOf() is NaN — no meaningful numeric coercion', () => {
    expect(new Reference('users/u1').valueOf()).toBeNaN();
  });

  test('equals() compares by path string, not instance identity', () => {
    const a = new Reference('users/u1');
    const b = new Reference('users/u1');
    const c = new Reference('users/u2');
    expect(a === b).toBe(false);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.equals('users/u1')).toBe(false); // string is not a Reference
  });

  test('toJSON() produces a stable {__type, path} debug shape', () => {
    expect(new Reference('users/u1').toJSON()).toEqual({
      __type: 'reference', path: 'users/u1',
    });
  });

  test('constructor normalizes leading slash', () => {
    expect(new Reference('/users/u1').path).toBe('users/u1');
  });

  test('constructor strips fully-qualified resource prefix', () => {
    expect(
      new Reference('projects/p/databases/(default)/documents/users/u1').path,
    ).toBe('users/u1');
  });

  test('fromResourceName() decodes the wire format', () => {
    const r = Reference.fromResourceName(
      'projects/p/databases/(default)/documents/users/u1/posts/p1',
    );
    expect(r.path).toBe('users/u1/posts/p1');
  });
});

describe('referenceToResourceName', () => {
  test('emits the projects/.../documents/<path> wire string', () => {
    expect(referenceToResourceName(new Reference('users/u1'))).toBe(
      'projects/sim/databases/(default)/documents/users/u1',
    );
  });

  test('honors caller-supplied projectId / databaseId', () => {
    expect(
      referenceToResourceName(new Reference('users/u1'), 'real-proj', 'mydb'),
    ).toBe('projects/real-proj/databases/mydb/documents/users/u1');
  });
});

describe('Reference path parity in Firestore rules', () => {
  test('equals() matches /databases/<databaseId>/documents/<path> symmetrically with Path', () => {
    const defaultRef = new Reference('users/u1');
    const qualifiedDefaultRef = new Reference('projects/p/databases/(default)/documents/users/u1');
    const analyticsRef = new Reference('projects/p/databases/analytics/documents/users/u1');
    const defaultPath = Path.fromString('/databases/(default)/documents/users/u1');
    const analyticsPath = Path.fromString('/databases/analytics/documents/users/u1');
    const shortPath = Path.fromString('/users/u1');

    expect(defaultRef.equals(qualifiedDefaultRef)).toBe(true);
    expect(defaultRef.equals(analyticsRef)).toBe(false);
    expect(defaultRef.equals(defaultPath)).toBe(true);
    expect(defaultPath.equals(defaultRef)).toBe(true);
    expect(defaultRef.equals(analyticsPath)).toBe(false);
    expect(analyticsPath.equals(defaultRef)).toBe(false);
    expect(analyticsRef.equals(analyticsPath)).toBe(true);
    expect(analyticsPath.equals(analyticsRef)).toBe(true);
    expect(defaultRef.equals(shortPath)).toBe(false);
    expect(shortPath.equals(defaultRef)).toBe(false);
  });

  test('satisfies both `is path` and `is reference` and compares equal to matching path literals', () => {
    const rules = firestoreRules(`
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /items/{id} {
            allow read: if resource.data.ownerRef is path
              && resource.data.ownerRef is reference
              && !(resource.data.ownerRef is string)
              && !(resource.data.ownerRef is map)
              && resource.data.ownerRef == /databases/$(database)/documents/users/$(request.auth.uid)
              && /databases/$(database)/documents/users/$(request.auth.uid) == resource.data.ownerRef;
            allow create: if request.resource.data.ownerRef is path
              && request.resource.data.ownerRef is reference
              && request.resource.data.ownerRef == /databases/$(database)/documents/users/$(request.auth.uid);
          }
        }
      }
    `);

    const report = rules.simulate([
      {
        description: 'seeded reference satisfies is path, is reference, and path equality',
        expectation: 'ALLOW',
        method: 'get',
        path: 'items/i1',
        auth: { uid: 'alice' },
        resource: { ownerRef: reference('users/alice') },
      },
      {
        description: 'incoming reference write satisfies is path, is reference, and path equality',
        expectation: 'ALLOW',
        method: 'create',
        path: 'items/i2',
        auth: { uid: 'alice' },
        data: { ownerRef: reference('users/alice') },
      },
      {
        description: 'mismatched reference target denies path equality',
        expectation: 'DENY',
        method: 'create',
        path: 'items/i3',
        auth: { uid: 'alice' },
        data: { ownerRef: reference('users/bob') },
      },
    ]);

    expect(report.cases.map((c) => c.decision)).toEqual(['ALLOW', 'ALLOW', 'DENY']);
  });
});
