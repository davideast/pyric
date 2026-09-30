/**
 * ─── Scenario: stdlib-sets-and-mapdiff ──────────────────────────────────────
 * Sets and MapDiff in Storage rules: `List.toSet()`, the Set membership and
 * algebra methods, order-insensitive Set equality, `in` over a Set, and
 * `Map.diff()` over custom metadata with every MapDiff key-set accessor. The
 * List membership methods `hasAny()` and `hasOnly()` sit beside their Set
 * counterparts.
 *
 * Negative controls pin the receiver and argument boundary: Set algebra takes
 * a Set argument, and a List receiver has no Set algebra. Metadata keys named
 * `constructor` and `toString` pin that a diff reads own keys only. The
 * `value-identity-*` matches pin how a Set and `diff()` compare ints, floats,
 * zeros and NaN. The `set-method-*` matches pin which methods a Set and a
 * MapDiff have, the argument each Set method takes, and the error for Set
 * algebra on a List, string or Map receiver.
 */
import type { StorageScenarioRecord } from './types.ts';

const REQUEST_TIME = '2025-06-15T00:00:00Z';

/** One Set or diff() case: description, allow condition, production verdict. */
type ValueIdentityCase = readonly [description: string, condition: string, expectation: 'ALLOW' | 'DENY'];

/**
 * A Set and `diff()` compare values by numeric value at every depth, where a
 * List does not: `[1, 1.0].toSet()` has one element, `[[1]].toSet() ==
 * [[1.0]].toSet()`, `0.0` and `-0.0` are one element, NaN is one element
 * that is a member of its own Set, and `diff()` reports an int and the equal
 * float, `0.0` and `-0.0`, and two NaN as unchanged.
 */
const VALUE_IDENTITY_CASES: readonly ValueIdentityCase[] = [
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
  ['diff() of an int and the equal float is unchanged', "{'a': 1}.diff({'a': 1.0}).affectedKeys().size() == 0", 'ALLOW'],
  ['diff() of an int and the equal float lists the key as unchanged', "{'x': 1}.diff({'x': 1.0}).unchangedKeys().size() == 1", 'ALLOW'],
  ['diff() of an int List and the equal float List is unchanged', "{'x': [1]}.diff({'x': [1.0]}).changedKeys().size() == 0", 'ALLOW'],
  ['diff() of 0.0 and -0.0 is unchanged', "{'x': 0.0}.diff({'x': -0.0}).changedKeys().size() == 0", 'ALLOW'],
  ['diff() of NaN and NaN is unchanged', "{'x': float('NaN')}.diff({'x': float('NaN')}).changedKeys().size() == 0", 'ALLOW'],
  ['diff() of an int and a different float is changed', "{'x': 1}.diff({'x': 2.0}).changedKeys().size() == 1", 'ALLOW'],
];

const valueIdentityMatches = VALUE_IDENTITY_CASES.map(([, condition], index) =>
  `    match /value-identity-${index}/{id} {
      allow get: if ${condition};
    }`).join('\n');

/**
 * A Set has `size()`, `hasAll()`, `hasAny()`, `hasOnly()`, `difference()`,
 * `union()` and `intersection()`, and no Map method: `keys()`, `values()`,
 * `get()` and `diff()` on a Set, and `keys()`, `values()`, `get()` and
 * `size()` on a MapDiff, are "Function not found error". The membership
 * methods take one List or Set argument, the algebra methods one Set
 * argument, and `size()` none; another argument type is an unsupported
 * operation and another count "Incorrect number of arguments". A List,
 * string or Map receiver has no Set algebra. Error cases negate a comparison
 * that is false when the call succeeds, so ALLOW would show a value and DENY
 * shows the error.
 */
const SET_METHOD_CASES: readonly ValueIdentityCase[] = [
  ['size() counts the elements', "['a', 'b', 'a'].toSet().size() == 2", 'ALLOW'],
  ['size() != the count is false', "['a', 'b', 'a'].toSet().size() != 2", 'DENY'],
  ['size() with an argument is an error', "!(['a'].toSet().size(1) == 9)", 'DENY'],
  ['keys() on a Set is an error', "!(['a'].toSet().keys() == ['z'])", 'DENY'],
  ['|| true absorbs keys() on a Set', "(['a'].toSet().keys() == ['z']) || true", 'ALLOW'],
  ['values() on a Set is an error', "!(['a'].toSet().values() == ['z'])", 'DENY'],
  ['get() on a Set is an error', "!(['a'].toSet().get('a', 1) == 0)", 'DENY'],
  ['diff() on a Set is an error', "!(['a'].toSet().diff({'a': 1}).addedKeys().size() == 99)", 'DENY'],
  ['keys() on a MapDiff is an error', "!({'a': 1}.diff({}).keys() == ['z'])", 'DENY'],
  ['values() on a MapDiff is an error', "!({'a': 1}.diff({}).values() == [1])", 'DENY'],
  ['get() on a MapDiff is an error', "!({'a': 1}.diff({}).get('a', 1) == 0)", 'DENY'],
  ['size() on a MapDiff is an error', "!({'a': 1}.diff({}).size() == 99)", 'DENY'],
  ['hasOnly() with a List argument', "['a', 'b'].toSet().hasOnly(['a', 'b', 'c'])", 'ALLOW'],
  ['hasAll() != false with a missing element', "['a'].toSet().hasAll(['a', 'b']) != false", 'DENY'],
  ['a string argument to hasAny() is an error', "!(['a'].toSet().hasAny('a'))", 'DENY'],
  ['|| true absorbs a string argument to hasAny()', "(['a'].toSet().hasAny('a')) || true", 'ALLOW'],
  ['a Map argument to hasAll() is an error', "!(['a'].toSet().hasAll({'a': 1}))", 'DENY'],
  ['a string argument to hasOnly() is an error', "!(['a'].toSet().hasOnly('a'))", 'DENY'],
  ['hasAll() with two arguments is an error', "!(['a'].toSet().hasAll(['a'], ['a']))", 'DENY'],
  ['hasAny() with no argument is an error', "!(['a'].toSet().hasAny())", 'DENY'],
  ['union() of two Sets', "['a'].toSet().union(['b'].toSet()) == ['a', 'b'].toSet()", 'ALLOW'],
  ['union() != the joined Set is false', "['a'].toSet().union(['b'].toSet()) != ['a', 'b'].toSet()", 'DENY'],
  ['a string argument to union() is an error', "!(['a'].toSet().union('a') == ['a'].toSet())", 'DENY'],
  ['a Map argument to difference() is an error', "!(['a'].toSet().difference({'a': 1}) == ['a'].toSet())", 'DENY'],
  ['a List argument to difference() is an error', "!(['a'].toSet().difference(['a']) == ['a'].toSet())", 'DENY'],
  ['intersection() with no argument is an error', "!(['a'].toSet().intersection() == ['a'].toSet())", 'DENY'],
  ['union() with no argument is an error', "!(['a'].toSet().union() == ['a'].toSet())", 'DENY'],
  ['|| true absorbs union() with no argument', "(['a'].toSet().union() == ['a'].toSet()) || true", 'ALLOW'],
  [
    'intersection() with two arguments is an error',
    "!(['a'].toSet().intersection(['a'].toSet(), ['a'].toSet()) == ['a'].toSet())",
    'DENY',
  ],
  ['difference() on a List is an error', '!([1].difference([1].toSet()) == [1].toSet())', 'DENY'],
  ['union() on a List is an error', '!([1].union([1].toSet()) == [1].toSet())', 'DENY'],
  ['intersection() on a List is an error', '!([1].intersection([1].toSet()) == [1].toSet())', 'DENY'],
  ['|| true absorbs union() on a List', '([1].union([1].toSet()) == [1].toSet()) || true', 'ALLOW'],
  ['intersection() on a string is an error', "!('a'.intersection(['a'].toSet()) == ['a'].toSet())", 'DENY'],
  ['difference() on a Map is an error', "!({'a': 1}.difference(['a'].toSet()) == ['a'].toSet())", 'DENY'],
];

const setMethodMatches = SET_METHOD_CASES.map(([, condition], index) =>
  `    match /set-method-${index}/{id} {
      allow get: if ${condition};
    }`).join('\n');

function getCase(description: string, expectation: 'ALLOW' | 'DENY', path: string) {
  return {
    description,
    expectation,
    method: 'get' as const,
    path,
    existingResource: { size: 10, metadata: { owner: 'alice', label: 'old' } },
    requestTime: REQUEST_TIME,
  };
}

function updateCase(
  description: string,
  expectation: 'ALLOW' | 'DENY',
  path: string,
  incoming: Record<string, string>,
  existing: Record<string, string>,
) {
  return {
    description,
    expectation,
    method: 'update' as const,
    path,
    resource: { size: 10, metadata: incoming },
    existingResource: { size: 10, metadata: existing },
    requestTime: REQUEST_TIME,
  };
}

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-STDLIB-SET',
  rationale:
    'List.toSet(), Set membership and algebra, Set equality, in over a Set, and Map.diff() over custom metadata with every MapDiff accessor, with a List argument to Set algebra and a List receiver as negative controls.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function metadataDiff() {
      return request.resource.metadata.diff(resource.metadata);
    }
    match /to-set/{id} {
      allow get: if ['a', 'a', 'b'].toSet().size() == 2
        && ['a', 'b'].toSet() == ['b', 'a'].toSet();
    }
    match /membership/{id} {
      allow get: if ['a', 'b'].toSet().hasAll(['a'])
        && ['a', 'b'].toSet().hasAny(['z', 'b'])
        && ['a'].toSet().hasOnly(['a', 'b'])
        && ['a', 'b'].toSet().hasAll(['a'].toSet());
    }
    match /list-membership/{id} {
      allow get: if ['a', 'b'].hasAny(['z', 'b']) && ['a'].hasOnly(['a', 'b'])
        && !['a', 'c'].hasOnly(['a', 'b']);
    }
    match /algebra/{id} {
      allow get: if ['a', 'b'].toSet().difference(['a'].toSet()) == ['b'].toSet()
        && ['a'].toSet().union(['b'].toSet()).size() == 2
        && ['a', 'b'].toSet().intersection(['b', 'c'].toSet()) == ['b'].toSet();
    }
    match /algebra-list-argument/{id} {
      allow get: if ['a', 'b'].toSet().difference(['a']).size() == 1;
    }
    match /list-receiver-algebra/{id} {
      allow get: if ['a', 'b'].difference(['a'].toSet()).size() == 1;
    }
    match /in-set/{id} {
      allow get: if 'a' in ['a', 'b'].toSet() && !('z' in ['a', 'b'].toSet());
    }
    match /metadata-keys-set/{id} {
      allow get: if resource.metadata.keys().toSet().hasOnly(['owner', 'label']);
    }
    match /diff/{id} {
      allow update: if metadataDiff().addedKeys() == ['tag'].toSet()
        && metadataDiff().removedKeys() == ['gone'].toSet()
        && metadataDiff().changedKeys() == ['label'].toSet()
        && metadataDiff().unchangedKeys() == ['owner'].toSet()
        && metadataDiff().affectedKeys() == ['tag', 'gone', 'label'].toSet();
    }
    match /diff-prototype-key/{id} {
      allow update: if metadataDiff().addedKeys() == ['constructor'].toSet()
        && metadataDiff().removedKeys() == ['toString'].toSet();
    }
    match /diff-guard/{id} {
      allow update: if metadataDiff().affectedKeys().hasOnly(['label']);
    }
    match /diff-in/{id} {
      allow update: if 'label' in metadataDiff().changedKeys();
    }
${valueIdentityMatches}
${setMethodMatches}
  }
}`,
  cases: [
    getCase('toSet removes duplicates and set equality ignores order', 'ALLOW', 'to-set/a'),
    getCase('set hasAll, hasAny, and hasOnly', 'ALLOW', 'membership/a'),
    getCase('list hasAny and hasOnly', 'ALLOW', 'list-membership/a'),
    getCase('set difference, union, and intersection', 'ALLOW', 'algebra/a'),
    getCase('set algebra with a list argument is an error', 'DENY', 'algebra-list-argument/a'),
    getCase('list receiver has no set algebra', 'DENY', 'list-receiver-algebra/a'),
    getCase('in over a set', 'ALLOW', 'in-set/a'),
    getCase('metadata keys as a set', 'ALLOW', 'metadata-keys-set/a'),
    updateCase(
      'metadata diff accessors',
      'ALLOW',
      'diff/a',
      { owner: 'alice', label: 'new', tag: 'x' },
      { owner: 'alice', label: 'old', gone: 'y' },
    ),
    updateCase(
      'metadata diff adds and removes keys named like prototype members',
      'ALLOW',
      'diff-prototype-key/a',
      { owner: 'alice', constructor: 'x' },
      { owner: 'alice', toString: 'y' },
    ),
    updateCase(
      'metadata diff guard allows a label-only change',
      'ALLOW',
      'diff-guard/a',
      { owner: 'alice', label: 'new' },
      { owner: 'alice', label: 'old' },
    ),
    updateCase(
      'metadata diff guard denies an owner change',
      'DENY',
      'diff-guard/b',
      { owner: 'bob', label: 'old' },
      { owner: 'alice', label: 'old' },
    ),
    updateCase(
      'in over metadata diff changedKeys',
      'ALLOW',
      'diff-in/a',
      { owner: 'alice', label: 'new' },
      { owner: 'alice', label: 'old' },
    ),
    ...VALUE_IDENTITY_CASES.map(([description, , expectation], index) =>
      getCase(`value identity: ${description}`, expectation, `value-identity-${index}/a`)),
    ...SET_METHOD_CASES.map(([description, , expectation], index) =>
      getCase(`set method: ${description}`, expectation, `set-method-${index}/a`)),
  ],
};
