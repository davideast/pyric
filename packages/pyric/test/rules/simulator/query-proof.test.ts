import { describe, test, expect } from 'bun:test';
import {
  evaluateQueryProof,
  referencesResourceData,
  type QueryConstraints,
} from '../../../src/rules/simulator/query-proof.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { collectAllRules, collectAllFunctions } from '../../../src/rules/linter/ast-utils.js';
import type { Expression, FunctionDef } from '../../../src/rules/grammar/FirestoreAST.js';

// ── Helpers: parse a rules file, pull out the `list`/`read` rule condition ──
//
// The proof is a pure function over the rule-condition AST + the query
// constraints, so we drive it through the REAL grammar (not hand-built ASTs) to
// keep these probes faithful to what `simulate()` actually evaluates.
function listConditionOf(source: string): { condition: Expression; fnMap: Map<string, FunctionDef> } {
  const ast = parseToAST(source);
  if (!ast) throw new Error('failed to parse rules');
  const fnMap = new Map<string, FunctionDef>();
  for (const fn of collectAllFunctions(ast.service.match)) fnMap.set(fn.name, fn);
  for (const { rule } of collectAllRules(ast.service.match)) {
    if (rule.operations.includes('list') || rule.operations.includes('read')) {
      return { condition: rule.condition, fnMap };
    }
  }
  throw new Error('no list/read rule found');
}

function rules(listRule: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      ${listRule}
    }
  }
}`;
}

describe('RULES-B11 (rules-side): query-proof evaluation', () => {
  describe('doc-independent rules → any query is provable', () => {
    test('allow list: if true → provable with no constraints', () => {
      const { condition, fnMap } = listConditionOf(rules('allow list: if true;'));
      const r = evaluateQueryProof(condition, {}, fnMap);
      expect(r.provable).toBe(true);
    });

    test('allow list: if request.auth != null → provable (auth-only, no doc data)', () => {
      const { condition, fnMap } = listConditionOf(rules('allow list: if request.auth != null;'));
      expect(evaluateQueryProof(condition, {}, fnMap).provable).toBe(true);
    });

    test('read rule using request.query but not resource.data → provable', () => {
      const { condition, fnMap } = listConditionOf(
        rules('allow read: if request.query.limit <= 50;'),
      );
      expect(evaluateQueryProof(condition, { limit: 50 }, fnMap).provable).toBe(true);
    });
  });

  describe('doc-dependent rules → "rules are not filters"', () => {
    // The canonical prod example: allow list only if each doc is public.
    const PUBLIC_RULE = rules("allow list: if resource.data.visibility == 'public';");

    test('REJECT: no matching where() — prod denies the whole query, not filters', () => {
      const { condition, fnMap } = listConditionOf(PUBLIC_RULE);
      const r = evaluateQueryProof(condition, {}, fnMap);
      expect(r.provable).toBe(false);
      expect(r.reason).toMatch(/rules are not filters|no matching where/i);
    });

    test('PROVABLE: query carries where(visibility, ==, public)', () => {
      const { condition, fnMap } = listConditionOf(PUBLIC_RULE);
      const constraints: QueryConstraints = {
        where: [{ field: 'visibility', op: '==', value: 'public' }],
      };
      expect(evaluateQueryProof(condition, constraints, fnMap).provable).toBe(true);
    });

    test('REJECT: where() on the field but WRONG value', () => {
      const { condition, fnMap } = listConditionOf(PUBLIC_RULE);
      const constraints: QueryConstraints = {
        where: [{ field: 'visibility', op: '==', value: 'private' }],
      };
      expect(evaluateQueryProof(condition, constraints, fnMap).provable).toBe(false);
    });

    test('REJECT: where() with a non-equality op does not discharge an == requirement', () => {
      const { condition, fnMap } = listConditionOf(PUBLIC_RULE);
      const constraints: QueryConstraints = {
        where: [{ field: 'visibility', op: '!=', value: 'private' }],
      };
      expect(evaluateQueryProof(condition, constraints, fnMap).provable).toBe(false);
    });

    test('auth + doc-data conjunction: both predicates must be discharged', () => {
      const { condition, fnMap } = listConditionOf(
        rules("allow list: if request.auth != null && resource.data.published == true;"),
      );
      // auth conjunct is doc-independent; the doc-data conjunct needs a where().
      expect(evaluateQueryProof(condition, {}, fnMap).provable).toBe(false);
      expect(
        evaluateQueryProof(condition, { where: [{ field: 'published', op: '==', value: true }] }, fnMap).provable,
      ).toBe(true);
    });

    test('two required equalities: ALL must be covered by where()', () => {
      const { condition, fnMap } = listConditionOf(
        rules("allow list: if resource.data.a == 1 && resource.data.b == 2;"),
      );
      expect(
        evaluateQueryProof(condition, { where: [{ field: 'a', op: '==', value: 1 }] }, fnMap).provable,
      ).toBe(false); // b uncovered
      expect(
        evaluateQueryProof(condition, {
          where: [
            { field: 'a', op: '==', value: 1 },
            { field: 'b', op: '==', value: 2 },
          ],
        }, fnMap).provable,
      ).toBe(true);
    });

    test('REJECT (conservative): disjunction over doc data is not unconditionally required', () => {
      // `resource.data.a == 1 || resource.data.b == 2` — neither predicate is
      // guaranteed, so no where() can prove it. Conservative reject (safe dir).
      const { condition, fnMap } = listConditionOf(
        rules("allow list: if resource.data.a == 1 || resource.data.b == 2;"),
      );
      expect(
        evaluateQueryProof(condition, { where: [{ field: 'a', op: '==', value: 1 }] }, fnMap).provable,
      ).toBe(false);
    });

    test('REJECT (conservative): range/inequality predicate is not a dischargeable equality', () => {
      const { condition, fnMap } = listConditionOf(
        rules('allow list: if resource.data.score > 10;'),
      );
      expect(evaluateQueryProof(condition, { where: [{ field: 'score', op: '>', value: 10 }] }, fnMap).provable)
        .toBe(false);
    });
  });

  describe('function inlining during extraction (RULES-B11)', () => {
    // Helper wrapping the canonical public-doc predicate. Detection already
    // saw through the helper; extraction now does too.
    const PUBLIC_HELPER = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      function isPublic() { return resource.data.visibility == 'public'; }
      allow list: if isPublic();
    }
  }
}`;

    test('helper-wrapped rule with NO discharging where stays unprovable (missing residual)', () => {
      const { condition, fnMap } = listConditionOf(PUBLIC_HELPER);
      const r = evaluateQueryProof(condition, {}, fnMap);
      expect(r.provable).toBe(false);
      if (r.provable) throw new Error('unreachable');
      expect(r.residual.missing).toEqual([
        { field: 'visibility', expectedValue: 'public', fromAuthUid: false },
      ]);
      expect(r.residual.mismatched).toHaveLength(0);
      expect(r.residual.outOfScope).toBeUndefined();
    });

    test('helper + matching where → provable (was conservative-rejected pre-fix)', () => {
      const { condition, fnMap } = listConditionOf(PUBLIC_HELPER);
      const r = evaluateQueryProof(condition, {
        where: [{ field: 'visibility', op: '==', value: 'public' }],
      }, fnMap);
      expect(r.provable).toBe(true);
    });

    test('helper with a parameter, auth-pinned owner → provable with where(owner == uid)', () => {
      const { condition, fnMap } = listConditionOf(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      function isOwner(uid) { return resource.data.ownerUid == uid; }
      allow list: if isOwner(request.auth.uid);
    }
  }
}`);
      // Unprovable without the discharging where; the missing equality is
      // flagged fromAuthUid so remediation can suggest request.auth.uid.
      const bare = evaluateQueryProof(condition, {}, fnMap, 'alice');
      expect(bare.provable).toBe(false);
      if (bare.provable) throw new Error('unreachable');
      expect(bare.residual.missing).toEqual([
        { field: 'ownerUid', expectedValue: 'alice', fromAuthUid: true },
      ]);
      // Provable once the query pins owner == the caller's uid.
      expect(
        evaluateQueryProof(condition, { where: [{ field: 'ownerUid', op: '==', value: 'alice' }] }, fnMap, 'alice').provable,
      ).toBe(true);
      // A where pinning someone else's uid does not discharge it.
      expect(
        evaluateQueryProof(condition, { where: [{ field: 'ownerUid', op: '==', value: 'bob' }] }, fnMap, 'alice').provable,
      ).toBe(false);
    });

    test('nested helpers (helper calling helper) inline through both', () => {
      const { condition, fnMap } = listConditionOf(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      function visibilityIs(v) { return resource.data.visibility == v; }
      function isPublic() { return visibilityIs('public'); }
      allow list: if isPublic();
    }
  }
}`);
      expect(evaluateQueryProof(condition, {}, fnMap).provable).toBe(false);
      expect(
        evaluateQueryProof(condition, { where: [{ field: 'visibility', op: '==', value: 'public' }] }, fnMap).provable,
      ).toBe(true);
    });

    test('flipped equality order inside a helper (literal == resource.data.field)', () => {
      const { condition, fnMap } = listConditionOf(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      function isPublic() { return 'public' == resource.data.visibility; }
      allow list: if isPublic();
    }
  }
}`);
      expect(
        evaluateQueryProof(condition, { where: [{ field: 'visibility', op: '==', value: 'public' }] }, fnMap).provable,
      ).toBe(true);
    });

    test('helper body with && of two data equalities requires both wheres', () => {
      const { condition, fnMap } = listConditionOf(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      function ok() { return resource.data.a == 1 && resource.data.b == 2; }
      allow list: if ok();
    }
  }
}`);
      expect(
        evaluateQueryProof(condition, { where: [{ field: 'a', op: '==', value: 1 }] }, fnMap).provable,
      ).toBe(false); // b uncovered
      expect(
        evaluateQueryProof(condition, {
          where: [
            { field: 'a', op: '==', value: 1 },
            { field: 'b', op: '==', value: 2 },
          ],
        }, fnMap).provable,
      ).toBe(true);
    });

    test('out-of-scope helper body (disjunction) stays unprovable with outOfScope residual', () => {
      const { condition, fnMap } = listConditionOf(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      function ok() { return resource.data.a == 1 || resource.data.b == 2; }
      allow list: if ok();
    }
  }
}`);
      const r = evaluateQueryProof(condition, { where: [{ field: 'a', op: '==', value: 1 }] }, fnMap);
      expect(r.provable).toBe(false);
      if (r.provable) throw new Error('unreachable');
      expect(r.residual.outOfScope).toBeDefined();
      expect(r.residual.missing).toHaveLength(0);
      expect(r.residual.mismatched).toHaveLength(0);
    });

    test('mismatched value residual: where on the field, wrong value', () => {
      const { condition, fnMap } = listConditionOf(PUBLIC_HELPER);
      const r = evaluateQueryProof(condition, { where: [{ field: 'visibility', op: '==', value: 'private' }] }, fnMap);
      expect(r.provable).toBe(false);
      if (r.provable) throw new Error('unreachable');
      expect(r.residual.mismatched).toEqual([
        { field: 'visibility', expectedValue: 'public', actualValue: 'private' },
      ]);
      expect(r.residual.missing).toHaveLength(0);
    });
  });

  describe('referencesResourceData', () => {
    test('detects resource.data through a user function', () => {
      const { condition, fnMap } = listConditionOf(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      function isPublic() { return resource.data.visibility == 'public'; }
      allow list: if isPublic();
    }
  }
}`);
      expect(referencesResourceData(condition, fnMap)).toBe(true);
      // …and is therefore not provable without a where() (helper inlines to a
      // required equality no query constraint discharges).
      expect(evaluateQueryProof(condition, {}, fnMap).provable).toBe(false);
    });

    test('request.resource.data (write payload) is NOT per-doc read data', () => {
      const { condition, fnMap } = listConditionOf(
        rules('allow list: if request.resource.data.x == 1;'),
      );
      // request.resource.data is the write payload, irrelevant to a list read;
      // it is not `resource.data`, so the rule is treated as doc-independent.
      expect(referencesResourceData(condition, fnMap)).toBe(false);
      expect(evaluateQueryProof(condition, {}, fnMap).provable).toBe(true);
    });
  });
});
