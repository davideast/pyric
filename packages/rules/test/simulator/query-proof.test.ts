import { describe, test, expect } from 'bun:test';
import { firestoreRules, reference } from '../../src/index.js';
import { evaluateQueryProof, type QueryConstraints } from '../../src/simulator/query-proof.js';
import { renderQueryRemediation } from '../../src/simulator/list-query-proof.js';
import {
  formatQueryScalarForRemediation,
  isQueryProofScalar,
  queryProofScalarsEqual,
  replaceTokenInQueryScalar,
} from '../../src/simulator/query-proof-residual.js';
import { isProvablyDocIndependent, referencesResourceData } from '../../src/simulator/query-proof-scope.js';
import { Bytes } from '../../src/simulator/wrappers/bytes.js';
import { Duration } from '../../src/simulator/wrappers/duration.js';
import { RulesFloat } from '../../src/simulator/wrappers/float.js';
import { LatLng } from '../../src/simulator/wrappers/latlng.js';
import { Path } from '../../src/simulator/wrappers/path.js';
import { Reference } from '../../src/simulator/wrappers/reference.js';
import { Timestamp } from '../../src/simulator/wrappers/timestamp.js';
import { parseToAST } from '../../src/grammar/FirestoreParser.js';
import { collectAllRules, collectAllFunctions } from '../../src/linter/ast-utils.js';
import type { Expression, FunctionDef } from '../../src/grammar/FirestoreAST.js';

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

    test('a query-guaranteed positive OR branch is sufficient', () => {
      // Pinning a guarantees the left branch for every possible returned document.
      const { condition, fnMap } = listConditionOf(
        rules("allow list: if resource.data.a == 1 || resource.data.b == 2;"),
      );
      expect(
        evaluateQueryProof(condition, { where: [{ field: 'a', op: '==', value: 1 }] }, fnMap).provable,
      ).toBe(true);
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

    test('helper disjunction projects a sufficient residual and retains rejected-branch evidence', () => {
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
      expect(r.provable).toBe(true);
      if (!r.provable) throw new Error('expected residual');
      expect(r.residualCondition).toBeDefined();
      expect(r.proofFailure?.residual.outOfScope).toBeDefined();
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

  describe('full accounting: doc-dependent non-equality conjuncts reject even with discharged equalities', () => {
    // The synthetic representative resource carries only the where-pinned
    // fields, so an absent-tolerant conjunct (`in`, negated `in`, `get(...,
    // default)`, `keys().hasOnly`) would evaluate truthy against it while a
    // real matching doc violates the rule — the proof must reject up front.
    const DISCHARGED: QueryConstraints = { where: [{ field: 'a', op: '==', value: 1 }] };

    const expectOutOfScope = (source: string) => {
      const { condition, fnMap } = listConditionOf(source);
      const r = evaluateQueryProof(condition, DISCHARGED, fnMap);
      expect(r.provable).toBe(false);
      if (r.provable) throw new Error('unreachable');
      expect(r.residual.outOfScope).toBeDefined();
      expect(r.residual.missing).toHaveLength(0);
      expect(r.residual.mismatched).toHaveLength(0);
    };

    const helperRules = (body: string) => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      function ok() { return ${body}; }
      allow list: if ok();
    }
  }
}`;

    test('inline: equality + negated `in` (absence check) → out-of-scope reject', () => {
      expectOutOfScope(rules("allow list: if resource.data.a == 1 && !('secret' in resource.data);"));
    });

    test('helper: equality + negated `in` (the demonstrated attack shape) → out-of-scope reject', () => {
      expectOutOfScope(helperRules("resource.data.a == 1 && !('secret' in resource.data)"));
    });

    test('inline: equality + positive `in` membership check → out-of-scope reject', () => {
      expectOutOfScope(rules("allow list: if resource.data.a == 1 && 'flag' in resource.data;"));
    });

    test('helper: equality + positive `in` membership check → out-of-scope reject', () => {
      expectOutOfScope(helperRules("resource.data.a == 1 && 'flag' in resource.data"));
    });

    test('inline: equality + `get(key, default)` comparison → out-of-scope reject', () => {
      expectOutOfScope(rules("allow list: if resource.data.a == 1 && resource.data.get('kind', 'open') == 'open';"));
    });

    test('helper: equality + `get(key, default)` comparison → out-of-scope reject', () => {
      expectOutOfScope(helperRules("resource.data.a == 1 && resource.data.get('kind', 'open') == 'open'"));
    });

    test('inline: equality + `keys().hasOnly(...)` → out-of-scope reject', () => {
      expectOutOfScope(rules("allow list: if resource.data.a == 1 && resource.data.keys().hasOnly(['a']);"));
    });

    test('helper: equality + `keys().hasOnly(...)` → out-of-scope reject', () => {
      expectOutOfScope(helperRules("resource.data.a == 1 && resource.data.keys().hasOnly(['a'])"));
    });

    test('inline: equality + doc-data range conjunct → out-of-scope reject (not the eval-error net)', () => {
      expectOutOfScope(rules('allow list: if resource.data.a == 1 && resource.data.b > 5;'));
    });

    test('inline: equality + `is` type check → out-of-scope reject', () => {
      expectOutOfScope(rules('allow list: if resource.data.a == 1 && resource.data.b is string;'));
    });

    test('boundary: pure-equality helper conjoined with doc-independent conjuncts stays provable', () => {
      // The point of function inlining — full accounting must not regress it:
      // doc-independent conjuncts (auth, request.query) are fine alongside
      // discharged equalities.
      const { condition, fnMap } = listConditionOf(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      function isOwner(uid) { return resource.data.ownerUid == uid; }
      allow list: if request.auth != null && isOwner(request.auth.uid) && request.query.limit <= 100;
    }
  }
}`);
      expect(
        evaluateQueryProof(
          condition,
          { where: [{ field: 'ownerUid', op: '==', value: 'alice' }], limit: 10 },
          fnMap,
          'alice',
        ).provable,
      ).toBe(true);
    });
  });

  describe('fail-closed classifier: every syntactic resource touch is doc-dependent', () => {
    // The classifier gates every allow: it must recognize `resource` in each
    // syntactic disguise, and treat any shape it does not positively know as
    // doc-dependent. Both review rounds found leaks by feeding the previous
    // fail-open enumeration a shape outside it.
    const DISCHARGED: QueryConstraints = { where: [{ field: 'a', op: '==', value: 1 }] };

    const expectOutOfScope = (source: string) => {
      const { condition, fnMap } = listConditionOf(source);
      const r = evaluateQueryProof(condition, DISCHARGED, fnMap);
      expect(r.provable).toBe(false);
      if (r.provable) throw new Error('unreachable');
      expect(r.residual.outOfScope).toBeDefined();
    };

    test("bracket access: equality + `!('secret' in resource['data'])` → reject", () => {
      expectOutOfScope(rules("allow list: if resource.data.a == 1 && !('secret' in resource['data']);"));
    });

    test('path literal: equality + exists(...) with a resource.data-dependent segment → reject', () => {
      // A document lookup whose path depends on doc data can never be
      // discharged by a where filter — the walked path-literal segments make
      // it doc-dependent.
      expectOutOfScope(rules(
        "allow list: if resource.data.a == 1 && !exists(/databases/$(database)/documents/banned/$(resource.data.get('owner', 'none')));",
      ));
    });

    test('slice access: equality + `resource.data.tags[0:1].size() == 1` → reject', () => {
      expectOutOfScope(rules('allow list: if resource.data.a == 1 && resource.data.tags[0:1].size() == 1;'));
    });

    test('resource identity (`resource.id`) is doc-dependent, not silently doc-independent', () => {
      expectOutOfScope(rules("allow list: if resource.data.a == 1 && resource.id != 'blocked';"));
      // …and alone it is unprovable too (per-doc identity, no where can discharge it).
      const { condition, fnMap } = listConditionOf(rules("allow list: if resource.id != 'blocked';"));
      expect(evaluateQueryProof(condition, {}, fnMap).provable).toBe(false);
    });

    test('unrecognized expression shape classifies doc-dependent (fail closed)', () => {
      // Simulate a future AST addition the classifier has not learned: an
      // unknown node type must classify doc-dependent (deny), never silently
      // doc-independent (allow).
      const exotic = { type: 'futureNode' } as unknown as Expression;
      expect(isProvablyDocIndependent(exotic)).toBe(false);
      const condition: Expression = {
        type: 'binaryOp',
        op: '&&',
        left: {
          type: 'binaryOp',
          op: '==',
          left: {
            type: 'memberAccess',
            property: 'a',
            object: {
              type: 'memberAccess',
              property: 'data',
              object: { type: 'identifier', name: 'resource' },
            },
          },
          right: { type: 'literal', value: 1, raw: '1' },
        },
        right: exotic,
      };
      const r = evaluateQueryProof(condition, DISCHARGED);
      expect(r.provable).toBe(false);
    });

    test('positive coverage: request.* chains, path variables, and stdlib calls stay doc-independent', () => {
      const { condition, fnMap } = listConditionOf(rules(
        "allow list: if request.auth != null && request.query.limit <= 50 && database != 'x';",
      ));
      expect(isProvablyDocIndependent(condition, fnMap)).toBe(true);
      expect(evaluateQueryProof(condition, { limit: 10 }, fnMap).provable).toBe(true);
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

  // FS-ENF-4a/4b/4c and FS-MET-5 (2, 3, 4, 5): domain intersection and
  // meaning-preserving rule rewrites.
  // Evidence: firebase.google.com/docs/firestore/security/rules-query; deployed
  // Firestore probe (FS-ENF-4c: contradictory `where('a','==',1)` + `where('a','==',2)`
  // is ALLOWED with 0 docs while single `where('a','==',1)` is denied under
  // `resource.data.a == 1 && resource.data.a == 2`); observations #182, #170, #163, #173.
  describe('domain intersection and meaning-preserving rewrites (FS-ENF-4, FS-MET-5)', () => {
    const proveRule = (
      body: string,
      where: NonNullable<QueryConstraints['where']>,
      authUid?: string,
    ) => {
      const { condition, fnMap } = listConditionOf(rules(body));
      return evaluateQueryProof(condition, { where }, fnMap, authUid);
    };

    test('FS-ENF-4a: singleton where(field, in, [v]) discharges resource.data.field == v', () => {
      const r = proveRule("allow list: if resource.data.status == 'open';", [
        { field: 'status', op: 'in', value: ['open'] },
      ]);
      expect(r.provable).toBe(true);
    });

    test('FS-ENF-4b: same-field where filters intersect regardless of filter order', () => {
      const filtersA: NonNullable<QueryConstraints['where']> = [
        { field: 'status', op: 'in', value: ['open', 'closed'] },
        { field: 'status', op: '==', value: 'open' },
      ];
      const filtersB: NonNullable<QueryConstraints['where']> = [
        { field: 'status', op: '==', value: 'open' },
        { field: 'status', op: 'in', value: ['open', 'closed'] },
      ];
      expect(proveRule("allow list: if resource.data.status == 'open';", filtersA).provable).toBe(true);
      const inThenEq = proveRule("allow list: if resource.data.status in ['open'];", filtersA);
      const eqThenIn = proveRule("allow list: if resource.data.status in ['open'];", filtersB);
      expect(inThenEq.provable).toBe(true);
      expect(eqThenIn.provable).toBe(true);
      if (!inThenEq.provable || !eqThenIn.provable) throw new Error('expected provable');
      expect(inThenEq.residualCondition).toEqual(eqThenIn.residualCondition);
    });

    // Evidence: scratch/firestore-hunt/production/probe-fs-enf-4c-vacuity-result.json (2026-10-17)
    test('FS-ENF-4c: filter conjunction implies rule equalities without empty-domain vacuity', () => {
      const a1AndA2 = 'allow list: if resource.data.a == 1 && resource.data.a == 2;';
      const a1 = 'allow list: if resource.data.a == 1;';
      const a3 = 'allow list: if resource.data.a == 3;';
      const ownerAlice = "allow list: if resource.data.owner == 'alice';";
      const eq1Eq2: NonNullable<QueryConstraints['where']> = [
        { field: 'a', op: '==', value: 1 },
        { field: 'a', op: '==', value: 2 },
      ];

      expect(proveRule(a1AndA2, [{ field: 'a', op: '==', value: 1 }]).provable).toBe(false);
      const contradictoryBoth = proveRule(a1AndA2, eq1Eq2);
      expect(contradictoryBoth.provable).toBe(true);
      if (!contradictoryBoth.provable) throw new Error('expected provable');
      expect(isProvablyDocIndependent(contradictoryBoth.residualCondition!, new Map())).toBe(true);

      expect(proveRule(a1, eq1Eq2).provable).toBe(true);
      expect(proveRule(a3, eq1Eq2).provable).toBe(false);
      expect(
        proveRule(ownerAlice, [
          { field: 'owner', op: '==', value: 'bob' },
          { field: 'owner', op: '==', value: 'carol' },
        ]).provable,
      ).toBe(false);
      expect(proveRule(a1, [{ field: 'a', op: 'in', value: [1] }]).provable).toBe(true);
      expect(proveRule(a1, [{ field: 'a', op: 'in', value: [1, 2] }]).provable).toBe(false);
    });

    test('FS-MET-5 (2 & 5): helper returning resource.data and bracket field access', () => {
      const { condition: helperCond, fnMap: helperFns } = listConditionOf(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      function getData() { return resource.data; }
      allow list: if getData().owner == 'alice';
    }
  }
}`);
      expect(
        evaluateQueryProof(helperCond, { where: [{ field: 'owner', op: '==', value: 'alice' }] }, helperFns).provable,
      ).toBe(true);
      expect(
        proveRule("allow list: if resource.data['owner'] == 'alice';", [
          { field: 'owner', op: '==', value: 'alice' },
        ]).provable,
      ).toBe(true);
    });

    test('FS-MET-5 (3): array-contains discharges resource.data.tags.hasAny([v])', () => {
      expect(
        proveRule("allow list: if resource.data.tags.hasAny(['a']);", [
          { field: 'tags', op: 'array-contains', value: 'a' },
        ]).provable,
      ).toBe(true);
      expect(
        proveRule(
          'allow list: if resource.data.tags.hasAny([request.auth.uid]);',
          [{ field: 'tags', op: 'array-contains', value: 'alice' }],
          'alice',
        ).provable,
      ).toBe(true);
    });

    test('FS-MET-5 (4): De Morgan equivalents produce identical proof verdicts', () => {
      expect(
        proveRule("allow list: if !(resource.data.owner != 'alice' && resource.data.status != 'pub');", [
          { field: 'owner', op: '==', value: 'alice' },
        ]).provable,
      ).toBe(true);
    });
  });

  describe('typed RulesScalar constraints and remediation formatting', () => {
    test('accepts RulesScalar wrappers, RulesFloat, and safe bigint in QueryWhereConstraint without casts', () => {
      const { condition, fnMap } = listConditionOf(
        rules(
          'allow list: if resource.data.orgRef == /databases/(default)/documents/orgs/acme'
            + ' && resource.data.ratio == 1.5'
            + ' && resource.data.count == 42;',
        ),
      );
      const res = evaluateQueryProof(
        condition,
        {
          where: [
            { field: 'orgRef', op: '==', value: new Reference('orgs/acme') },
            { field: 'ratio', op: '==', value: new RulesFloat(1.5) },
            { field: 'count', op: '==', value: 42n },
          ],
        },
        fnMap,
      );
      expect(res.provable).toBe(true);

      expect(isQueryProofScalar(new Reference('orgs/acme'))).toBe(true);
      expect(isQueryProofScalar(Path.fromString('/databases/(default)/documents/orgs/acme'))).toBe(true);
      expect(queryProofScalarsEqual(
        new Reference('orgs/acme'),
        Path.fromString('/databases/(default)/documents/orgs/acme'),
      )).toBe(true);
      expect(queryProofScalarsEqual(
        new Reference('orgs/acme', 'analytics'),
        Path.fromString('/databases/(default)/documents/orgs/acme'),
      )).toBe(false);
    });

    test('formats wrapper scalars as valid client expressions and substitutes <uid> for __pyric_synth_uid__', () => {
      const { condition, fnMap } = listConditionOf(
        rules(
          'allow list: if resource.data.orgRef == /databases/(default)/documents/orgs/acme'
            + ' && resource.data.ownerRef == /databases/$(database)/documents/users/$(request.auth.uid)'
            + ' && resource.data.dueAt == timestamp.date(2026, 1, 1)'
            + " && resource.data.tagBytes == b'ab'"
            + ' && resource.data.loc == latlng.value(10.0, 20.0)'
            + " && resource.data.ttl == duration.value(30, 's');",
        ),
      );
      const proof = evaluateQueryProof(
        condition,
        {
          where: [{ field: 'orgRef', op: '==', value: new Reference('orgs/other') }],
        },
        fnMap,
        '__pyric_synth_uid__',
        { database: '(default)' },
      );
      expect(proof.provable).toBe(false);
      if (proof.provable) throw new Error('expected unprovable');

      expect(proof.reason).not.toContain('__type');
      expect(proof.reason).not.toContain('__pyric_synth_uid__');
      expect(proof.reason).toContain("doc(db, 'orgs', 'acme')");
      expect(proof.reason).toContain("doc(db, 'orgs', 'other')");
      expect(proof.reason).toContain("doc(db, 'users', <uid>)");

      const remediation = renderQueryRemediation(proof.residual);
      expect(remediation).toBeDefined();
      expect(remediation).not.toContain('__type');
      expect(remediation).not.toContain('__pyric_synth_uid__');
      expect(remediation).toContain(".where('orgRef', '==', doc(db, 'orgs', 'acme'))");
      expect(remediation).toContain("the query pins doc(db, 'orgs', 'other')");
      expect(remediation).toContain(".where('ownerRef', '==', doc(db, 'users', <uid>))");
      expect(remediation).toContain(
        ".where('dueAt', '==', Timestamp.fromDate(new Date('2026-01-01T00:00:00.000Z')))",
      );
      expect(remediation).toContain(
        ".where('tagBytes', '==', Bytes.fromUint8Array(new Uint8Array([97, 98])))",
      );
      expect(remediation).toContain(".where('loc', '==', new GeoPoint(10, 20))");
      expect(remediation).toContain(".where('ttl', '==', duration.value(30, 's'))");

      expect(
        formatQueryScalarForRemediation(
          Path.fromString('/databases/(default)/documents/users/__pyric_synth_uid__'),
          { uidExpression: 'currentUser.uid' },
        ),
      ).toBe("doc(db, 'users', currentUser.uid)");
      expect(
        formatQueryScalarForRemediation(new Reference('orgs/acme', 'analytics')),
      ).toBe("doc(getFirestore(app, 'analytics'), 'orgs', 'acme')");

      const substitutedPath = replaceTokenInQueryScalar(
        Path.fromString('/databases/(default)/documents/users/__pyric_synth_uid__'),
        '__pyric_synth_uid__',
        'u-42',
      );
      expect(substitutedPath).toBeInstanceOf(Path);
      expect(String(substitutedPath)).toBe('/databases/(default)/documents/users/u-42');
    });

    test('preserves Reference type and .id/.path/.parent members on Reference equality and finite-in pins', () => {
      const refRules = firestoreRules(`
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /items/{id} {
              allow read: if resource.data.ownerRef is reference
                && resource.data.ownerRef is path
                && resource.data.ownerRef.id == request.auth.uid
                && resource.data.ownerRef.parent == 'users'
                && resource.data.ownerRef.path == 'users/' + request.auth.uid
                && resource.data.ownerRef == /databases/$(database)/documents/users/$(request.auth.uid);
            }
          }
        }
      `);

      const simReport = refRules.simulate([
        {
          description: 'matching Reference equality pin satisfies is reference and .id/.parent/.path',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          auth: { uid: 'u1' },
          query: {
            where: [{ field: 'ownerRef', op: '==', value: reference('users/u1') }],
          },
        },
        {
          description: 'Reference equality pin with mismatched .id denies',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          auth: { uid: 'u1' },
          query: {
            where: [{ field: 'ownerRef', op: '==', value: reference('users/u2') }],
          },
        },
      ]);

      expect(simReport.cases[0]?.queryProof?.verdict).toBe('PROVABLE');
      expect(simReport.cases[0]?.decision).toBe('ALLOW');
      expect(simReport.cases[1]?.decision).toBe('DENY');
    });

    test('preserves __proto__, constructor, toString, and valueOf equality pins as own properties in syntheticResource', () => {
      for (const protoKey of ['__proto__', 'constructor', 'toString', 'valueOf']) {
        const protoRules = firestoreRules(`
          rules_version = '2';
          service cloud.firestore {
            match /databases/{database}/documents {
              match /items/{id} {
                allow get, list: if resource.data['${protoKey}'] == 'safe';
              }
            }
          }
        `);

        const res = protoRules.simulate([
          {
            description: `pinned ${protoKey} equality allows list`,
            expectation: 'ALLOW',
            method: 'list',
            path: 'items',
            auth: { uid: 'u1' },
            query: {
              where: [{ field: protoKey, op: '==', value: 'safe' }],
            },
          },
          {
            description: `unpinned ${protoKey} rejects list`,
            expectation: 'DENY',
            method: 'list',
            path: 'items',
            auth: { uid: 'u1' },
            query: {
              where: [{ field: 'other', op: '==', value: 'safe' }],
            },
          },
        ]);

        expect(res.cases[0]?.queryProof?.verdict).toBe('PROVABLE');
        expect(res.cases[0]?.decision).toBe('ALLOW');
        expect(res.cases[1]?.queryProof?.verdict).toBe('UNPROVABLE');
        expect(res.cases[1]?.decision).toBe('DENY');
      }
    });

    test('enforces 10-lookup budget on unprovable || branches, preceding allow rules, helpers, ternaries, and dynamic lookup paths', () => {
      const lookups = (count: number, offset = 0) =>
        Array.from(
          { length: count },
          (_, i) => `exists(/databases/$(database)/documents/configs/k${offset + i})`,
        ).join(' || ');

      const cases: Array<{
        name: string;
        rules: string;
        where: Array<{ field: string; op: '=='; value: string | boolean }>;
        expectedDecision: 'ALLOW' | 'DENY';
        expectedLimit?: 'document-lookups';
      }> = [
        {
          name: 'unprovable || branch guarded by in resource.data exceeding 10 lookups',
          rules: `
            rules_version = '2';
            service cloud.firestore {
              match /databases/{database}/documents {
                match /items/{id} {
                  allow get, list: if ('flag' in resource.data && (${lookups(11)}))
                    || resource.data.visibility == 'public';
                }
              }
            }
          `,
          where: [{ field: 'visibility', op: '==', value: 'public' }],
          expectedDecision: 'DENY',
          expectedLimit: 'document-lookups',
        },
        {
          name: 'unprovable || branch guarded by negated membership short-circuiting ||',
          rules: `
            rules_version = '2';
            service cloud.firestore {
              match /databases/{database}/documents {
                match /items/{id} {
                  allow get, list: if (!('flag' in resource.data) ? false : (${lookups(11)}))
                    || resource.data.visibility == 'public';
                }
              }
            }
          `,
          where: [{ field: 'visibility', op: '==', value: 'public' }],
          expectedDecision: 'DENY',
          expectedLimit: 'document-lookups',
        },
        {
          name: 'preceding allow rule guarded by resource.data.get exceeding 10 lookups',
          rules: `
            rules_version = '2';
            service cloud.firestore {
              match /databases/{database}/documents {
                match /items/{id} {
                  allow get, list: if resource.data.get('flag', false) == true && (${lookups(11)});
                  allow get, list: if resource.data.visibility == 'public';
                }
              }
            }
          `,
          where: [{ field: 'visibility', op: '==', value: 'public' }],
          expectedDecision: 'DENY',
          expectedLimit: 'document-lookups',
        },
        {
          name: 'helper-wrapped candidate wildcard guard exceeding 10 lookups',
          rules: `
            rules_version = '2';
            service cloud.firestore {
              match /databases/{database}/documents {
                function specialItem(docId) {
                  return docId == 'special' && (${lookups(11)});
                }
                match /items/{id} {
                  allow get, list: if specialItem(id) || resource.data.visibility == 'public';
                }
              }
            }
          `,
          where: [{ field: 'visibility', op: '==', value: 'public' }],
          expectedDecision: 'DENY',
          expectedLimit: 'document-lookups',
        },
        {
          name: 'dynamic lookup path segments reading unconstrained resource.data fields exceeding 10 lookups',
          rules: `
            rules_version = '2';
            service cloud.firestore {
              match /databases/{database}/documents {
                match /items/{id} {
                  allow get, list: if (${Array.from(
                    { length: 11 },
                    (_, i) => `exists(/databases/$(database)/documents/configs/$(resource.data.k${i}))`,
                  ).join(' || ')}) || resource.data.visibility == 'public';
                }
              }
            }
          `,
          where: [{ field: 'visibility', op: '==', value: 'public' }],
          expectedDecision: 'DENY',
          expectedLimit: 'document-lookups',
        },
        {
          name: 'positive control: resource-guarded branch within 10-lookup budget allows',
          rules: `
            rules_version = '2';
            service cloud.firestore {
              match /databases/{database}/documents {
                match /items/{id} {
                  allow get, list: if ('flag' in resource.data && (${lookups(10)}))
                    || resource.data.visibility == 'public';
                }
              }
            }
          `,
          where: [{ field: 'visibility', op: '==', value: 'public' }],
          expectedDecision: 'ALLOW',
        },
        {
          name: 'positive control: repeated read of identical dynamic lookup path shares cache slot',
          rules: `
            rules_version = '2';
            service cloud.firestore {
              match /databases/{database}/documents {
                match /items/{id} {
                  allow get, list: if (
                    exists(/databases/$(database)/documents/configs/$(resource.data.k0))
                    && get(/databases/$(database)/documents/configs/$(resource.data.k0)).data.ok == true
                    && (${lookups(9, 1)})
                  ) || resource.data.visibility == 'public';
                }
              }
            }
          `,
          where: [{ field: 'visibility', op: '==', value: 'public' }],
          expectedDecision: 'ALLOW',
        },
        {
          name: 'positive control: query-pinned false guard genuinely short-circuits 11 lookups',
          rules: `
            rules_version = '2';
            service cloud.firestore {
              match /databases/{database}/documents {
                match /items/{id} {
                  allow get, list: if (resource.data.flag == true && (${lookups(11)}))
                    || resource.data.visibility == 'public';
                }
              }
            }
          `,
          where: [
            { field: 'flag', op: '==', value: false },
            { field: 'visibility', op: '==', value: 'public' },
          ],
          expectedDecision: 'ALLOW',
        },
      ];

      for (const entry of cases) {
        const report = firestoreRules(entry.rules).simulate([
          {
            description: entry.name,
            expectation: entry.expectedDecision,
            method: 'list',
            path: 'items',
            auth: { uid: 'u1' },
            query: { where: entry.where },
          },
        ]);
        expect(report.cases[0]?.decision).toBe(entry.expectedDecision);
        expect(report.cases[0]?.resourceLimit?.kind).toBe(entry.expectedLimit);
      }
    });
  });
});
