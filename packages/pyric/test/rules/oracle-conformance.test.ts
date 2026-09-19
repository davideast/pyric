/**
 * The package-level oracle gate delegates to the same replay assertion used by
 * score and report computation. Keeping one implementation prevents the test
 * command and published trust number from disagreeing about replay semantics.
 */
import { describe, expect, it } from 'bun:test';
import { replayFirestoreRulesObservations } from '../../../../packages/conformance/src/firestore-rules-oracle-replay.ts';

const replays = await replayFirestoreRulesObservations();

describe('oracle conformance (rules-firestore)', () => {
  for (const replay of replays) {
    it(`${replay.rowId}: ${replay.name}: replays the captured production verdict contract`, () => {
      expect(replay.problems).toEqual([]);
    });
  }

  it('every captured rules-firestore observation maps to one registry row', () => {
    expect(replays).toHaveLength(32);
    expect(replays.every(({ rowId }) => /^firestore-rules#\d+$/.test(rowId))).toBe(true);
  });
});

import { LocalEnvironment } from 'pyric/sandbox/internal';
import { lintFirestoreRules } from '../../src/rules/linter/linter.js';

describe('unit-backed rules-firestore rows (standard behavior assertions)', () => {
  it('firestore-rules#190: getAfter() deep-merges pre-existing sibling state in batches and transactions', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/a {
      allow create: if getAfter(/databases/$(database)/documents/docs/b).data.meta.role == 'admin'
                    && getAfter(/databases/$(database)/documents/docs/b).data.updated == true;
    }
    match /docs/b {
      allow update: if true;
    }
  }
}`;
    const env = new LocalEnvironment();
    env.seed({
      rules,
      documents: { 'docs/b': { meta: { role: 'admin', team: 'eng' }, version: 1 } },
    });
    // Batch update on B sets { updated: true }. Pre-existing { meta: { role: 'admin' } } must be preserved in getAfter() evaluation!
    const result = env.batch([
      { method: 'update', path: 'docs/b', data: { updated: true } },
      { method: 'create', path: 'docs/a', data: { status: 'checked' } },
    ]);
    expect(result.allowed).toBe(true);
    expect(env.getDocument('docs/b')).toEqual({ meta: { role: 'admin', team: 'eng' }, version: 1, updated: true });
  });

  it('firestore-rules#191: compile-time AST verification rejects non-conforming bool(), math.isInfinite(), and Map hasAll()', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{doc} {
      allow read: if bool('true') == true;
      allow write: if math.isInfinite(1.0);
      allow delete: if request.resource.data.hasAll(['field']);
    }
  }
}`;
    const res = lintFirestoreRules(source);
    const ruleNames = res.warnings.map(w => w.rule);
    expect(ruleNames).toContain('HALLUCINATED_GLOBAL');
    expect(ruleNames).toContain('HALLUCINATED_METHOD');
  });
});

