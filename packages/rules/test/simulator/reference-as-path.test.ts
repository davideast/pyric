/**
 * Verifies that `reference(...)` values in `simulate()` behave as production
 * `rules.Path` values across type checks, equality, membership, lookups,
 * indexing, conversions, path interpolation, `.bind()`, and runtime type-error
 * diagnostics (#1451, `wire-forms` in `test/test/fixtures/case-wire/captures.json`).
 */
import { describe, expect, test } from 'bun:test';
import { firestoreRules, reference } from '../../src/index.js';

describe('Firestore simulator reads reference values as path (#1451)', () => {
  test('treats reference() as path across is, ==, in, string(), indexing, bind(), interpolation, and lookups', () => {
    const ruleset = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{id} {
      allow create: if
        request.resource.data.owner is path &&
        !(request.resource.data.owner is string) &&
        !(request.resource.data.owner is map) &&
        !(request.resource.data.owner is list) &&
        request.resource.data.owner == /databases/(default)/documents/users/alice &&
        /databases/(default)/documents/users/alice == request.resource.data.owner &&
        request.resource.data.owner != /databases/(default)/documents/users/bob &&
        request.resource.data.owner in [/databases/(default)/documents/users/alice] &&
        string(request.resource.data.owner) == '/databases/(default)/documents/users/alice' &&
        request.resource.data.owner[0] == 'databases' &&
        request.resource.data.owner[3] == 'users' &&
        request.resource.data.owner[4] == 'alice' &&
        request.resource.data.owner.bind({}) == /databases/(default)/documents/users/alice &&
        /$(request.resource.data.owner) == /databases/(default)/documents/users/alice &&
        exists(request.resource.data.owner) &&
        get(request.resource.data.owner).data.role == 'editor';
    }
  }
}`);

    const report = ruleset.simulate([
      {
        description: 'reference("users/alice") behaves as /databases/(default)/documents/users/alice',
        expectation: 'ALLOW',
        method: 'create',
        path: 'posts/p1',
        data: { owner: reference('users/alice') },
        functionMocks: [
          { function: 'exists', path: 'users/alice', result: true },
          { function: 'get', path: 'users/alice', result: { role: 'editor' } },
        ],
      },
    ]);
    expect(report.passed).toBe(1);
    expect(report.cases[0]?.decision).toBe('ALLOW');
  });

  test('spells the runtime type of a reference value as path in error diagnostics', () => {
    const ruleset = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{id} {
      allow create: if request.resource.data.owner;
      allow update: if int(request.resource.data.owner) == 1;
      allow delete: if resource.data.owner + 1 == 2;
    }
  }
}`);

    const report = ruleset.simulate([
      {
        description: 'non-boolean allow condition spells Received: [path]',
        expectation: 'DENY',
        method: 'create',
        path: 'posts/p1',
        data: { owner: reference('users/alice') },
      },
      {
        description: 'int(ref) spells Received: int(path)',
        expectation: 'DENY',
        method: 'update',
        path: 'posts/p1',
        resource: { owner: reference('users/alice') },
        data: { owner: reference('users/alice') },
      },
      {
        description: 'ref + 1 spells path in binary operator error',
        expectation: 'DENY',
        method: 'delete',
        path: 'posts/p1',
        resource: { owner: reference('users/alice') },
      },
    ]);

    expect(report.passed).toBe(3);
    expect(report.cases[0]?.trace[0]?.message).toBe(
      'Type error. Received: [path] Expected: [bool].',
    );
    expect(report.cases[1]?.trace[0]?.message).toContain('Received: int(path).');
    expect(report.cases[2]?.trace[0]?.message).toBe(
      "Operator '+' is not defined between path and int",
    );
  });
});
