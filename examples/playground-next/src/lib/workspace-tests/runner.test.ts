/**
 * W1 workspace test runner — the unit-level form of the W1 benchmark gate
 * (workstation-benchmarks.md §4): the case classes that were SYSTEMATICALLY
 * unfixable under the simulator sweep (authed list, seeded owner reads) must
 * pass against a correct reference ruleset. False-failure rate = 0.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { sandbox as fsOps } from 'pyric/firestore';
import { parseWorkspaceTestFile, runTestFile, runWorkspaceTests } from './runner';

const REFERENCE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{d}/documents {
    match /menuItems/{id} {
      allow read: if true;
      allow create, update, delete: if request.auth != null && request.auth.token.admin == true;
    }
    match /orders/{id} {
      allow get: if request.auth != null && resource.data.userId == request.auth.uid;
      allow list: if request.auth != null;
      allow create: if request.auth != null && request.resource.data.userId == request.auth.uid;
      allow delete: if request.auth != null && request.auth.token.admin == true;
    }
  }
}`;

describe('false-failure gate — previously-unfixable case classes pass', () => {
  test('authed list on a collection ALLOWs through the real query plane', async () => {
    const r = await runTestFile(
      'list.test.json',
      {
        seed: [{ path: 'orders/o1', data: { userId: 'alice' } }],
        cases: [
          { as: { uid: 'alice' }, do: { method: 'list', path: 'orders' }, expect: 'ALLOW' },
          { as: null, do: { method: 'list', path: 'orders' }, expect: 'DENY' },
        ],
      },
      REFERENCE_RULES,
    );
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(2);
  });

  test('seeded owner-read ALLOWs (resource.data is real, not {})', async () => {
    const r = await runTestFile(
      'owner.test.json',
      {
        seed: [{ path: 'orders/o1', data: { userId: 'alice', items: ['latte'] } }],
        cases: [
          { as: { uid: 'alice' }, do: { method: 'get', path: 'orders/o1' }, expect: 'ALLOW' },
          { as: { uid: 'mallory' }, do: { method: 'get', path: 'orders/o1' }, expect: 'DENY' },
        ],
      },
      REFERENCE_RULES,
    );
    expect(r.failures).toEqual([]);
  });

  test('coffee-shop class: full mixed file passes 8/8 against the reference rules', async () => {
    const r = await runTestFile(
      'coffee.test.json',
      {
        seed: [{ path: 'orders/o1', data: { userId: 'alice' } }],
        cases: [
          { as: { uid: 'admin1', token: { admin: true } }, do: { method: 'create', path: 'menuItems/latte', data: { name: 'Latte', price: 4.5 } }, expect: 'ALLOW', source: 'floor' },
          { as: { uid: 'alice' }, do: { method: 'create', path: 'menuItems/mocha', data: { name: 'Mocha' } }, expect: 'DENY', source: 'floor' },
          { as: null, do: { method: 'get', path: 'menuItems/latte' }, expect: 'ALLOW' },
          { as: { uid: 'alice' }, do: { method: 'list', path: 'menuItems' }, expect: 'ALLOW' },
          { as: { uid: 'alice' }, do: { method: 'create', path: 'orders/o2', data: { userId: 'alice' } }, expect: 'ALLOW' },
          { as: { uid: 'alice' }, do: { method: 'create', path: 'orders/o3', data: { userId: 'bob' } }, expect: 'DENY' },
          { as: { uid: 'alice' }, do: { method: 'get', path: 'orders/o1' }, expect: 'ALLOW' },
          { as: { uid: 'admin1', token: { admin: true } }, do: { method: 'delete', path: 'orders/o1' }, expect: 'ALLOW' },
        ],
      },
      REFERENCE_RULES,
    );
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(8);
  });
});

describe('execution contract — per-case isolation', () => {
  test('a case that mutates a doc does not affect the next case (write is rolled back)', async () => {
    // Case 1 ALLOW-creates orders/new1. Under the old shared-state
    // contract a later owner-get of that doc ALLOWed; under isolation
    // the create is rolled back before case 2 runs, so the get evaluates
    // against a MISSING doc → DENY (resource.data.userId is unreadable).
    const r = await runTestFile(
      'isolation.test.json',
      {
        cases: [
          { as: { uid: 'alice' }, do: { method: 'create', path: 'orders/new1', data: { userId: 'alice' } }, expect: 'ALLOW' },
          { as: { uid: 'alice' }, do: { method: 'get', path: 'orders/new1' }, expect: 'DENY' },
        ],
      },
      REFERENCE_RULES,
    );
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(2);
  });

  test('seed is re-applied before every case (delete then owner-get both pass)', async () => {
    // Case 1: admin ALLOW-deletes the seeded doc. Case 2: alice owner-gets
    // the SAME doc — only passes if the seed was restored. Case 3: admin
    // mutates status; case 4 (the user-session regression class) still
    // sees the seeded 'pending' status, not 'preparing'.
    const r = await runTestFile(
      'reseed.test.json',
      {
        seed: [{ path: 'orders/o1', data: { userId: 'alice', status: 'pending' } }],
        cases: [
          { as: { uid: 'admin1', token: { admin: true } }, do: { method: 'delete', path: 'orders/o1' }, expect: 'ALLOW' },
          { as: { uid: 'alice' }, do: { method: 'get', path: 'orders/o1' }, expect: 'ALLOW', name: 'seed restored after delete' },
          { as: { uid: 'admin1', token: { admin: true } }, do: { method: 'delete', path: 'orders/o1' }, expect: 'ALLOW', name: 'delete works again — prior delete rolled back' },
        ],
      },
      REFERENCE_RULES,
    );
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(3);
  });

  test('case outcomes do not depend on case order (mutating case first vs last)', async () => {
    const seed = [{ path: 'orders/o1', data: { userId: 'alice' } }];
    const mutate = { as: { uid: 'admin1', token: { admin: true } }, do: { method: 'delete' as const, path: 'orders/o1' }, expect: 'ALLOW' as const };
    const read = { as: { uid: 'alice' }, do: { method: 'get' as const, path: 'orders/o1' }, expect: 'ALLOW' as const };
    const a = await runTestFile('order-a.test.json', { seed, cases: [mutate, read] }, REFERENCE_RULES);
    const b = await runTestFile('order-b.test.json', { seed, cases: [read, mutate] }, REFERENCE_RULES);
    expect(a.failures).toEqual([]);
    expect(b.failures).toEqual([]);
  });

  test('rules deploy happens exactly once per file (reset touches data only)', async () => {
    const setRules = spyOn(fsOps, 'setRules');
    try {
      const r = await runTestFile(
        'deploy-once.test.json',
        {
          seed: [{ path: 'orders/o1', data: { userId: 'alice' } }],
          cases: [
            { as: { uid: 'alice' }, do: { method: 'get', path: 'orders/o1' }, expect: 'ALLOW' },
            { as: { uid: 'alice' }, do: { method: 'create', path: 'orders/o2', data: { userId: 'alice' } }, expect: 'ALLOW' },
            { as: { uid: 'admin1', token: { admin: true } }, do: { method: 'delete', path: 'orders/o1' }, expect: 'ALLOW' },
            { as: { uid: 'mallory' }, do: { method: 'get', path: 'orders/o1' }, expect: 'DENY' },
          ],
        },
        REFERENCE_RULES,
      );
      expect(r.failures).toEqual([]);
      expect(setRules).toHaveBeenCalledTimes(1);
    } finally {
      setRules.mockRestore();
    }
  });

  test('files are hermetic — file B does not see file A seeds', async () => {
    const report = await runWorkspaceTests(
      [
        {
          name: 'a.test.json',
          content: JSON.stringify({
            seed: [{ path: 'orders/shared', data: { userId: 'alice' } }],
            cases: [{ as: { uid: 'alice' }, do: { method: 'get', path: 'orders/shared' }, expect: 'ALLOW' }],
          }),
        },
        {
          name: 'b.test.json',
          content: JSON.stringify({
            // In file B the doc must NOT exist: owner-get evaluates against
            // resource.data = missing → DENY under the reference rules.
            cases: [{ as: { uid: 'alice' }, do: { method: 'get', path: 'orders/shared' }, expect: 'DENY' }],
          }),
        },
      ],
      REFERENCE_RULES,
    );
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(2);
  });

  test('non-rules errors report as ERROR with detail, never as DENY', async () => {
    const r = await runTestFile(
      'err.test.json',
      {
        cases: [
          // update on a missing doc under an ALLOWing identity — not a
          // rules denial; the test (or seed) is wrong, not the ruleset.
          { as: { uid: 'admin1', token: { admin: true } }, do: { method: 'update', path: 'menuItems/missing', data: { price: 1 } }, expect: 'ALLOW' },
        ],
      },
      REFERENCE_RULES,
    );
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]!.got).toBe('ERROR');
    expect(r.failures[0]!.detail).toBeTruthy();
  });

  test('failure rows carry source provenance for the escalation policy', async () => {
    const r = await runTestFile(
      'floor.test.json',
      {
        cases: [
          { as: null, do: { method: 'create', path: 'orders/x', data: {} }, expect: 'ALLOW', source: 'floor' },
        ],
      },
      REFERENCE_RULES,
    );
    expect(r.failures[0]!.source).toBe('floor');
    expect(r.failures[0]!.got).toBe('DENY');
  });
});

describe('parseWorkspaceTestFile', () => {
  test('rejects malformed input with actionable messages', () => {
    expect(() => parseWorkspaceTestFile('{')).toThrow(/not valid JSON/);
    expect(() => parseWorkspaceTestFile('{}')).toThrow(/`cases` must be a non-empty array/);
    expect(() =>
      parseWorkspaceTestFile(JSON.stringify({ cases: [{ as: null, do: { method: 'read', path: 'x/y' }, expect: 'ALLOW' }] })),
    ).toThrow(/method must be/);
    expect(() =>
      parseWorkspaceTestFile(JSON.stringify({ cases: [{ as: { name: 'no-uid' }, do: { method: 'get', path: 'x/y' }, expect: 'ALLOW' }] })),
    ).toThrow(/as must be null or/);
    expect(() =>
      parseWorkspaceTestFile(JSON.stringify({ seed: [{ path: 'orders', data: {} }], cases: [{ as: null, do: { method: 'get', path: 'x/y' }, expect: 'DENY' }] })),
    ).toThrow(/document path/);
  });

  test('a runWorkspaceTests file with bad JSON reports a file error, not a crash', async () => {
    const report = await runWorkspaceTests([{ name: 'bad.test.json', content: '{oops' }], REFERENCE_RULES);
    expect(report.ok).toBe(false);
    expect(report.files[0]!.error).toContain('not valid JSON');
  });
});
