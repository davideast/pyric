/**
 * `x in <set>` tests Set membership by Rules value equality.
 *
 * The Firestore Rules Test API allows every membership rule below for an
 * element the set holds and denies it for an element the set lacks. The sets
 * come from `List.toSet()`, Set algebra, and the MapDiff key-set accessors.
 * Production verdicts: corpus scenario
 * `set-algebra-difference-union-intersection`.
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../src/rules/test/spec.js';

const handler = new SimulateFirestoreRulesHandler();

function decide(condition: string): string {
  const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      allow update: if ${condition};
    }
  }
}`;
  const tc = {
    description: condition,
    expectation: 'ALLOW',
    method: 'update',
    path: 'c/1',
    auth: { uid: 'u' },
    resource: { board: { k: 1, u: 0, r: 5 } },
    data: { board: { k: 2, u: 0, a: 3 } },
  } as TestCase;
  const res = handler.simulate(source, [tc]);
  if (!res.success) throw new Error('simulate failed');
  return res.data.results[0]!.decision;
}

const diff = 'request.resource.data.board.diff(resource.data.board)';

describe('in over a Set', () => {
  test.each([
    ["'k' in ['k'].toSet()", 'ALLOW'],
    ["'z' in ['k'].toSet()", 'DENY'],
    ["!('z' in ['k'].toSet())", 'ALLOW'],
    ["!('k' in ['k'].toSet())", 'DENY'],
    ['1 in [1, 2].toSet()', 'ALLOW'],
    ["['a'] in [['a']].toSet()", 'ALLOW'],
    ["'j' in ['k'].toSet().union(['j'].toSet())", 'ALLOW'],
    [`'k' in ${diff}.affectedKeys()`, 'ALLOW'],
    [`'k' in ${diff}.changedKeys()`, 'ALLOW'],
    [`'a' in ${diff}.addedKeys()`, 'ALLOW'],
    [`'r' in ${diff}.removedKeys()`, 'ALLOW'],
    [`'u' in ${diff}.unchangedKeys()`, 'ALLOW'],
    [`'u' in ${diff}.affectedKeys()`, 'DENY'],
    [`!('u' in ${diff}.affectedKeys())`, 'ALLOW'],
    [`!('k' in ${diff}.affectedKeys())`, 'DENY'],
  ])('%s → %s', (condition, expected) => {
    expect(decide(condition)).toBe(expected);
  });
});
