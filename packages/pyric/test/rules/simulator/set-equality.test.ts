/**
 * RULES-B13 — FirestoreSet value equality.
 *
 * Production supports `set == set` (e.g.
 * `diff.addedKeys() == [request.auth.uid].toSet()`). Before the fix,
 * `FirestoreSet` was not a `RulesValue`, so `deepEqualsForRules` fell
 * into its generic-object branch — where the private JS `Set` exposes
 * no enumerable keys, so ANY two sets compared EQUAL. That divergence
 * was false-PERMISSIVE (simulator ALLOWED what production DENIES):
 * caught by joining validation, whose 10 cases all pass in the production
 * Rules Test API and, post-fix, in the simulator.
 *
 * These are the distilled end-to-end regressions.
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../src/rules/test/spec.js';

const SOURCE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /t/{id} {
      allow update: if request.resource.data.members.diff(resource.data.members)
        .addedKeys() == [request.auth.uid].toSet();
    }
  }
}`;

const handler = new SimulateFirestoreRulesHandler();

function run(expectation: 'ALLOW' | 'DENY', membersAfter: Record<string, string>) {
  const tc: TestCase = {
    description: 'set equality case',
    expectation,
    method: 'update',
    path: 't/1',
    auth: { uid: 'carol' },
    resource: { members: { alice: 'admin' } },
    data: { members: membersAfter },
  } as TestCase;
  const res = handler.simulate(SOURCE, [tc]);
  if (!res.success || !res.data) throw new Error('simulate failed');
  return res.data.results[0]!;
}

describe('RULES-B13: FirestoreSet == FirestoreSet is VALUE equality', () => {
  test('equal singleton sets → ALLOW (added exactly self)', () => {
    expect(run('ALLOW', { alice: 'admin', carol: 'editor' }).state).toBe('PASSED');
  });

  test('empty diff != singleton set → DENY (the always-equal bug allowed this)', () => {
    expect(run('DENY', { alice: 'admin' }).state).toBe('PASSED');
  });

  test('two-key added set != singleton set → DENY', () => {
    expect(run('DENY', { alice: 'admin', carol: 'x', dave: 'x' }).state).toBe('PASSED');
  });

  test('set == non-set (list) is false, not an error', () => {
    const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /t/{id} {
      allow update: if request.resource.data.members.diff(resource.data.members)
        .addedKeys() != ['carol'];
    }
  }
}`;
    const tc: TestCase = {
      description: 'set vs list inequality',
      expectation: 'ALLOW', // != a plain list is true (different types)
      method: 'update',
      path: 't/1',
      auth: { uid: 'carol' },
      resource: { members: { alice: 'admin' } },
      data: { members: { alice: 'admin', carol: 'editor' } },
    } as TestCase;
    const res = handler.simulate(src, [tc]);
    if (!res.success || !res.data) throw new Error('simulate failed');
    expect(res.data.results[0]!.state).toBe('PASSED');
  });
});
