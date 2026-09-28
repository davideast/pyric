/**
 * ─── Scenario 7: set-algebra-difference-union-intersection ────────────────────
 * Targets Item 5.1 of the rebuild plan — Set.difference / union /
 * intersection. The hosted production Test API accepts the ruleset but reports
 * Function-not-found evaluation errors when the receiver is Map.keys() (a
 * List), while explicit List.toSet() receivers implement all three methods.
 * The paired shapes make the receiver-type boundary distinguishable. The
 * membership cases test `in` over Sets from toSet(), union(), and the MapDiff
 * key-set accessors, with present, absent, and negated elements. The
 * setIdentity cases pin how a Set compares ints, floats, zeros and NaN.
 */
import type { ScenarioRecord } from './types.ts';

/** One Set case: description, allow condition, production verdict. */
type SetIdentityCase = readonly [description: string, condition: string, expectation: 'ALLOW' | 'DENY'];

/**
 * A Set compares its elements by numeric value at every depth, where a List
 * does not: `[1, 1.0].toSet()` has one element, `[[1]].toSet() ==
 * [[1.0]].toSet()`, `0.0` and `-0.0` are one element, and NaN is one element
 * that is a member of its own Set.
 */
const setIdentityCases: readonly SetIdentityCase[] = [
  ['a Set of an int equals a Set of the equal float', '[1].toSet() == [1.0].toSet()', 'ALLOW'],
  ['!= between a Set of an int and a Set of the equal float is false', '[1].toSet() != [1.0].toSet()', 'DENY'],
  ['an int and the equal float are one element', '[1, 1.0].toSet().size() == 1', 'ALLOW'],
  ['an int and the equal float are not two elements', '[1, 1.0].toSet().size() == 2', 'DENY'],
  ['an int is in a Set of the equal float', '1 in [1.0].toSet()', 'ALLOW'],
  ['a float is in a Set of the equal int', '1.0 in [1].toSet()', 'ALLOW'],
  ['hasAny() with a List of the equal float', '[1].toSet().hasAny([1.0])', 'ALLOW'],
  ['hasAny() != true is false for the equal float', '[1].toSet().hasAny([1.0]) != true', 'DENY'],
  ['hasAll() with a List of the equal float', '[1].toSet().hasAll([1.0])', 'ALLOW'],
  ['hasOnly() with a List of the equal float', '[1].toSet().hasOnly([1.0])', 'ALLOW'],
  ['hasAny() with a Set of the equal float', '[1].toSet().hasAny([1.0].toSet())', 'ALLOW'],
  ['difference() removes the equal float', '[1].toSet().difference([1.0].toSet()).size() == 0', 'ALLOW'],
  ['intersection() keeps the equal float', '[1].toSet().intersection([1.0].toSet()).size() == 1', 'ALLOW'],
  ['union() merges the equal float', '[1].toSet().union([1.0].toSet()).size() == 1', 'ALLOW'],
  ['a Set of an int List equals a Set of the equal float List', '[[1]].toSet() == [[1.0]].toSet()', 'ALLOW'],
  ['an int List and the equal float List are one element', '[[1], [1.0]].toSet().size() == 1', 'ALLOW'],
  ['a Map element matches the Map of the equal float', "[{'a': 1}].toSet().hasAny([{'a': 1.0}])", 'ALLOW'],
  ['an int List is in a Set of the equal float List', '[1] in [[1.0]].toSet()', 'ALLOW'],
  ['nested Map and List elements compare by value', "[{'a': [1]}].toSet() == [{'a': [1.0]}].toSet()", 'ALLOW'],
  ['a Set of 0.0 equals a Set of -0.0', '[0.0].toSet() == [-0.0].toSet()', 'ALLOW'],
  ['0.0 and -0.0 are one element', '[0.0, -0.0].toSet().size() == 1', 'ALLOW'],
  ['a Set of a 0.0 List equals a Set of a -0.0 List', '[[0.0]].toSet() == [[-0.0]].toSet()', 'ALLOW'],
  ['two NaN are one element', "[float('NaN'), float('NaN')].toSet().size() == 1", 'ALLOW'],
  ['a Set of NaN equals a Set of NaN', "[float('NaN')].toSet() == [float('NaN')].toSet()", 'ALLOW'],
  ['NaN is in a Set of NaN', "float('NaN') in [float('NaN')].toSet()", 'ALLOW'],
  ['hasAny() finds NaN', "[float('NaN')].toSet().hasAny([float('NaN')])", 'ALLOW'],
  ['two NaN Lists are one element', "[[float('NaN')], [float('NaN')]].toSet().size() == 1", 'ALLOW'],
];

const setIdentityBlocks = setIdentityCases
  .map(([, condition], index) => `    match /setIdentity/${index}/{id} {
      allow create: if ${condition};
    }`)
  .join('\n');

export const scenario: ScenarioRecord = {
  fm: 'Item 5.1',
  rationale: 'Production distinguishes Map.keys() List receivers (no set algebra) from explicit List.toSet() Set receivers (difference/union/intersection supported); paired cases lock the boundary.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // difference — items in this not in other (list arg)
    match /diffListAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().difference(['a','b']).hasOnly(['c']);
    }
    // difference — Set arg via .keys()
    match /diffSetAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.keys().difference(request.resource.data.b.keys()).hasOnly(['x']);
    }
    // union — items in either
    match /unionAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().union(['c','d']).size() == 4;
    }
    // union — overlap dedupes
    match /unionDedupAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().union(['b','c']).size() == 3;
    }
    // intersection — items in both
    match /interAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().intersection(['b','c','d']).hasOnly(['b','c']);
    }
    // intersection — empty when no overlap
    match /interEmptyAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().intersection(['x','y']).size() == 0;
    }
    // chained: union then difference
    match /chainAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().union(['c']).difference(['a']).hasOnly(['b','c']);
    }
    // DENY witness — wrong size after difference
    match /diffDeny/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().difference(['a']).size() == 99;
    }
    // Positive Set witnesses — explicit toSet() receivers.
    match /toSetDiffAllow/{id} {
      allow create: if [1, 2].toSet().difference([1].toSet()).hasOnly([2]);
    }
    match /toSetUnionAllow/{id} {
      allow create: if [1].toSet().union([2].toSet()).hasOnly([1, 2]);
    }
    match /toSetInterAllow/{id} {
      allow create: if [1, 2].toSet().intersection([2].toSet()).hasOnly([2]);
    }
    match /toSetDiffDeny/{id} {
      allow create: if [1, 2].toSet().difference([1].toSet()).size() == 99;
    }
    // Membership: \`in\` over a Set compares elements by value.
    match /setInAllow/{id} {
      allow create: if 'k' in ['k'].toSet();
    }
    match /setInAbsentDeny/{id} {
      allow create: if 'z' in ['k'].toSet();
    }
    match /setNotInAllow/{id} {
      allow create: if !('z' in ['k'].toSet());
    }
    match /setNotInPresentDeny/{id} {
      allow create: if !('k' in ['k'].toSet());
    }
    match /setIntInAllow/{id} {
      allow create: if 1 in [1, 2].toSet();
    }
    match /setUnionInAllow/{id} {
      allow create: if 'j' in ['k'].toSet().union(['j'].toSet());
    }
    match /affectedInAllow/{id} {
      allow update: if 'k' in request.resource.data.board.diff(resource.data.board).affectedKeys();
    }
    match /changedInAllow/{id} {
      allow update: if 'k' in request.resource.data.board.diff(resource.data.board).changedKeys();
    }
    match /addedInAllow/{id} {
      allow update: if 'a' in request.resource.data.board.diff(resource.data.board).addedKeys();
    }
    match /removedInAllow/{id} {
      allow update: if 'r' in request.resource.data.board.diff(resource.data.board).removedKeys();
    }
    match /unchangedInAllow/{id} {
      allow update: if 'u' in request.resource.data.board.diff(resource.data.board).unchangedKeys();
    }
    match /affectedInAbsentDeny/{id} {
      allow update: if 'u' in request.resource.data.board.diff(resource.data.board).affectedKeys();
    }
    match /affectedNotInAllow/{id} {
      allow update: if !('u' in request.resource.data.board.diff(resource.data.board).affectedKeys());
    }
    match /affectedNotInPresentDeny/{id} {
      allow update: if !('k' in request.resource.data.board.diff(resource.data.board).affectedKeys());
    }
${setIdentityBlocks}
  }
}`,
  cases: [
    {
      description: 'set difference (list arg) → hasOnly([c]) DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'diffListAllow/d1',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2, c: 3 } },
    },
    {
      description: 'set difference (set arg) → hasOnly([x]) DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'diffSetAllow/d2',
      auth: { uid: 'alice' },
      data: { a: { x: 1, y: 2 }, b: { y: 2, z: 3 } },
    },
    {
      description: 'set union → size 4 DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'unionAllow/d3',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
    {
      description: 'set union dedupes overlap → size 3 DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'unionDedupAllow/d4',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
    {
      description: 'set intersection → hasOnly([b,c]) DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'interAllow/d5',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2, c: 3 } },
    },
    {
      description: 'set intersection no overlap → empty DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'interEmptyAllow/d6',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
    {
      description: 'chained union+difference → hasOnly([b,c]) DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'chainAllow/d7',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
    {
      description: 'difference with wrong expected size DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'diffDeny/d8',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    },
    {
      description: 'explicit toSet difference ALLOW', expectation: 'ALLOW', method: 'create',
      path: 'toSetDiffAllow/d9', auth: null, data: {},
    },
    {
      description: 'explicit toSet union ALLOW', expectation: 'ALLOW', method: 'create',
      path: 'toSetUnionAllow/d10', auth: null, data: {},
    },
    {
      description: 'explicit toSet intersection ALLOW', expectation: 'ALLOW', method: 'create',
      path: 'toSetInterAllow/d11', auth: null, data: {},
    },
    {
      description: 'explicit toSet difference wrong size DENY', expectation: 'DENY', method: 'create',
      path: 'toSetDiffDeny/d12', auth: null, data: {},
    },
    ...([
      ['string in toSet() holding it ALLOW', 'ALLOW', 'setInAllow'],
      ['string in toSet() lacking it DENY', 'DENY', 'setInAbsentDeny'],
      ['negated in toSet() lacking it ALLOW', 'ALLOW', 'setNotInAllow'],
      ['negated in toSet() holding it DENY', 'DENY', 'setNotInPresentDeny'],
      ['int in toSet() holding it ALLOW', 'ALLOW', 'setIntInAllow'],
      ['string in union() result ALLOW', 'ALLOW', 'setUnionInAllow'],
    ] as const).map(([description, expectation, match], i) => ({
      description, expectation, method: 'create' as const,
      path: `${match}/d${13 + i}`, auth: null, data: {},
    })),
    ...([
      ['changed key in affectedKeys() ALLOW', 'ALLOW', 'affectedInAllow'],
      ['changed key in changedKeys() ALLOW', 'ALLOW', 'changedInAllow'],
      ['added key in addedKeys() ALLOW', 'ALLOW', 'addedInAllow'],
      ['removed key in removedKeys() ALLOW', 'ALLOW', 'removedInAllow'],
      ['unchanged key in unchangedKeys() ALLOW', 'ALLOW', 'unchangedInAllow'],
      ['unchanged key in affectedKeys() DENY', 'DENY', 'affectedInAbsentDeny'],
      ['negated unchanged key in affectedKeys() ALLOW', 'ALLOW', 'affectedNotInAllow'],
      ['negated changed key in affectedKeys() DENY', 'DENY', 'affectedNotInPresentDeny'],
    ] as const).map(([description, expectation, match], i) => ({
      description, expectation, method: 'update' as const,
      path: `${match}/d${19 + i}`, auth: { uid: 'alice' },
      resource: { board: { k: 1, u: 0, r: 5 } },
      data: { board: { k: 2, u: 0, a: 3 } },
    })),
    ...setIdentityCases.map(([description, , expectation], index) => ({
      description: `setIdentity: ${description}`,
      expectation,
      method: 'create' as const,
      path: `setIdentity/${index}/d1`,
      auth: { uid: 'alice' },
      data: {},
    })),
  ],
  group: 'stress',
};
