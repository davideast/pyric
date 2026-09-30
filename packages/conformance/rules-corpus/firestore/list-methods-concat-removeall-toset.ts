/**
 * ─── Scenario 8: list-methods-concat-removeall-toset ──────────────────────────
 * Targets Item 5.2 of the rebuild plan — List.concat / removeAll / toSet.
 * Pre-fix all three threw UnsupportedError. toSet bridges into Set.* (5.1)
 * — a few cases chain through to verify the produced Set is fully usable.
 *
 * The listMethod cases pin List membership and `removeAll()` over ints and
 * floats, `join()`'s separator and element conversion, the error for a
 * List method on a string, Map or Set receiver, and the argument a List
 * receiver's `hasAll()`, `hasAny()` and `hasOnly()` take.
 */
import type { ScenarioRecord } from './types.ts';

/** One List-method case: description, allow condition, production verdict. */
type ListMethodCase = readonly [description: string, condition: string, expectation: 'ALLOW' | 'DENY'];

/**
 * List membership (`in`, `hasAny()`, `hasAll()`, `hasOnly()`) and
 * `removeAll()` compare an element's numeric type: an int is not a member of
 * a List of the equal float. `-0.0` is a member of `[0.0]`, NaN is a member
 * of nothing, and a List or Map element compares as `==` compares Lists and
 * Maps. `join(separator)` requires one string separator and converts each
 * element as `string()` does. A List method on a string, Map or Set receiver
 * is "Function not found error". A List receiver's `hasAll()`, `hasAny()`
 * and `hasOnly()` take one List argument: a Set, string, Map or null
 * argument is an unsupported operation, and another argument count is
 * "Incorrect number of arguments". Error cases negate a comparison that is
 * false when the call succeeds, so ALLOW would show a value and DENY shows
 * the error.
 */
const listMethodCases: readonly ListMethodCase[] = [
  ['in: a float is not in a List of the equal int', '1.0 in [1]', 'DENY'],
  ['in: !(float in a List of the equal int) is true', '!(1.0 in [1])', 'ALLOW'],
  ['in: an int is not in a List of the equal float', '1 in [1.0]', 'DENY'],
  ['in: -0.0 is in a List of 0.0', '-0.0 in [0.0]', 'ALLOW'],
  ['in: an int zero is not in a List of -0.0', '0 in [-0.0]', 'DENY'],
  ['in: NaN is not in a List of NaN', "float('NaN') in [float('NaN')]", 'DENY'],
  ['in: a List of an int is not in a List of a List of the equal float', '[1] in [[1.0]]', 'DENY'],
  ['in: a Map of an int is not in a List of a Map of the equal float', "{'a': 1} in [{'a': 1.0}]", 'DENY'],
  ['in: a List of 0.0 is not in a List of a List of -0.0', '[0.0] in [[-0.0]]', 'DENY'],
  ['in: a float is in a List of the same float', '2.5 in [2.5]', 'ALLOW'],
  ['hasAny: an int List has no float of the same value', '[1].hasAny([1.0])', 'DENY'],
  ['hasAny: != true for a float of the same value', '[1].hasAny([1.0]) != true', 'ALLOW'],
  ['hasAny: a float List has no int of the same value', '[1.0].hasAny([1])', 'DENY'],
  ['hasAll: an int List does not have all of a float List', '[1].hasAll([1.0])', 'DENY'],
  ['hasOnly: an int List does not have only a float List', '[1].hasOnly([1.0])', 'DENY'],
  ['hasAll: a mixed List has all of a float List', '[1, 2.5].hasAll([2.5])', 'ALLOW'],
  ['hasAny: a List of 0.0 has -0.0', '[0.0].hasAny([-0.0])', 'ALLOW'],
  ['hasAny: a List of an int List has no List of the equal float', '[[1]].hasAny([[1.0]])', 'DENY'],
  ['hasAny: a List of a 0.0 List has no List of -0.0', '[[0.0]].hasAny([[-0.0]])', 'DENY'],
  ['removeAll: a float argument leaves the equal int', '[1, 2].removeAll([1.0]) == [1, 2]', 'ALLOW'],
  ['removeAll: a float argument does not remove the equal int', '[1, 2].removeAll([1.0]) == [2]', 'DENY'],
  ['removeAll: an int argument leaves the equal float', '[1.0, 2].removeAll([1]) == [1.0, 2]', 'ALLOW'],
  ['removeAll: an int argument removes the equal int', '[1, 2].removeAll([1]) == [2]', 'ALLOW'],
  ['removeAll: a 0.0 argument removes -0.0', '[-0.0].removeAll([0.0]) == []', 'ALLOW'],
  ['removeAll: a float List argument leaves the equal int List', '[[1]].removeAll([[1.0]]) == [[1]]', 'ALLOW'],
  ['removeAll: a float argument removes the same float', '[2.5].removeAll([2.5]) == []', 'ALLOW'],
  ['join: joins with the separator', "['a', 'b'].join(',') == 'a,b'", 'ALLOW'],
  ['join: != the joined string is false', "['a', 'b'].join(',') != 'a,b'", 'DENY'],
  ['join: no separator is an error', "['a', 'b'].join() == 'a,b'", 'DENY'],
  ['join: no separator is an error under negation', "!(['a', 'b'].join() == 'z')", 'DENY'],
  ['join: || true absorbs the no-separator error', "(['a', 'b'].join() == 'z') || true", 'ALLOW'],
  ['join: two separators is an error', "!(['a'].join(',', ',') == 'z')", 'DENY'],
  ['join: an int separator is an error', "!(['a'].join(1) == 'z')", 'DENY'],
  ['join: a null element is the text null', "['a', null].join(',') == 'a,null'", 'ALLOW'],
  ['join: a null element is not the empty string', "['a', null].join(',') == 'a,'", 'DENY'],
  ['join: a float element keeps its fraction', "[2.0].join(',') == '2.0'", 'ALLOW'],
  ['join: a float element is not printed as an int', "[2.0].join(',') == '2'", 'DENY'],
  ['join: floats convert as string() does', "[-0.5, 100000000.0, 1.5].join(',') == '-0.5,1.0E8,1.5'", 'ALLOW'],
  ['join: int and bool elements convert as string() does', "['a', 1, true].join('|') == 'a|1|true'", 'ALLOW'],
  ['join: a path element converts as string() does', "[path('/a/b')].join(',') == '/a/b'", 'ALLOW'],
  ['join: a List element is an error', "!([['a']].join(',') == 'z')", 'DENY'],
  ['join: || true absorbs a List element error', "([['a']].join(',') == 'z') || true", 'ALLOW'],
  ['join: a Map element is an error', "!([{'k': 'v'}].join(',') == 'z')", 'DENY'],
  ['join: a bytes element is an error', "!([b'ab'].join(',') == 'z')", 'DENY'],
  ['join: a duration element is an error', "!([duration.value(1, 's')].join(',') == 'z')", 'DENY'],
  ['join: an empty List joins to the empty string', "[].join(',') == ''", 'ALLOW'],
  ['join: an empty separator', "['a', 'b'].join('') == 'ab'", 'ALLOW'],
  ['receiver: concat on a string is an error', "!('a'.concat('b') == 'z')", 'DENY'],
  ['receiver: || true absorbs concat on a string', "('a'.concat('b') == 'z') || true", 'ALLOW'],
  ['receiver: removeAll on a string is an error', "!('a'.removeAll(['a']) == 'z')", 'DENY'],
  ['receiver: join on a string is an error', "!('a'.join(',') == 'z')", 'DENY'],
  ['receiver: toSet on a string is an error', "!('a'.toSet() == ['a'].toSet())", 'DENY'],
  ['receiver: hasAny on a string is an error', "!('a'.hasAny(['a']))", 'DENY'],
  ['receiver: hasAll on a string is an error', "!('a'.hasAll(['a']))", 'DENY'],
  ['receiver: hasOnly on a string is an error', "!('a'.hasOnly(['a']))", 'DENY'],
  ['receiver: concat on a Map is an error', "!({'a': 1}.concat([1]) == [1])", 'DENY'],
  ['receiver: removeAll on a Map is an error', "!({'a': 1}.removeAll(['a']) == {})", 'DENY'],
  ['receiver: join on a Map is an error', "!({'a': 1}.join(',') == 'z')", 'DENY'],
  ['receiver: toSet on a Map is an error', "!({'a': 1}.toSet() == ['a'].toSet())", 'DENY'],
  ['receiver: hasAll on a Map is an error', "!({'a': 1}.hasAll(['a']))", 'DENY'],
  ['receiver: concat on a Set is an error', "!(['a'].toSet().concat(['b']) == ['z'])", 'DENY'],
  ['receiver: removeAll on a Set is an error', "!(['a'].toSet().removeAll(['a']) == ['z'].toSet())", 'DENY'],
  ['receiver: join on a Set is an error', "!(['a'].toSet().join(',') == 'z')", 'DENY'],
  ['argument: hasAll with a List argument', "['a', 'b'].hasAll(['b', 'a'])", 'ALLOW'],
  ['argument: hasAll != false with a missing element', "['a', 'b'].hasAll(['a', 'z']) != false", 'DENY'],
  ['argument: a Set argument to hasAll on a List is an error', "!(['a', 'b'].hasAll(['z'].toSet()))", 'DENY'],
  ['argument: a Set argument to hasAny on a List is an error', "!(['a', 'b'].hasAny(['z'].toSet()))", 'DENY'],
  ['argument: a Set argument to hasOnly on a List is an error', "!(['a', 'b'].hasOnly(['z'].toSet()))", 'DENY'],
  ['argument: || true absorbs a Set argument to hasAny on a List', "(['a', 'b'].hasAny(['z'].toSet())) || true", 'ALLOW'],
  ['argument: a string argument to hasAny is an error', "!(['a', 'b'].hasAny('z'))", 'DENY'],
  ['argument: a string argument to hasOnly is an error', "!(['a'].hasOnly('z'))", 'DENY'],
  ['argument: a Map argument to hasAll is an error', "!([1, 2].hasAll({'a': 1}))", 'DENY'],
  ['argument: a null argument to hasOnly is an error', '!([1, 2].hasOnly(null))', 'DENY'],
  ['argument: || true absorbs a string argument to hasAll', "([1, 2].hasAll('a')) || true", 'ALLOW'],
  ['argument: hasAny with no argument is an error', '!([1, 2].hasAny())', 'DENY'],
  ['argument: hasAll with two arguments is an error', '!([1, 2].hasAll([1], [2]))', 'DENY'],
];

const listMethodBlocks = listMethodCases
  .map(([, condition], index) => `    match /listMethod/${index}/{id} {
      allow create: if ${condition};
    }`)
  .join('\n');

export const scenario: ScenarioRecord = {
  fm: 'Item 5.2',
  rationale: 'Sim must implement List.concat/removeAll/toSet; pre-fix all three threw UnsupportedError.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // concat — basic
    match /concatAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.concat(request.resource.data.b).size() == 4;
    }
    // concat — preserves order
    match /concatOrderAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.concat(['c'])[2] == 'c';
    }
    // concat — does NOT dedupe
    match /concatNoDedupAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.concat(['a','b']).size() == 4;
    }
    // removeAll — basic
    match /removeAllAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.removeAll(['b']).size() == 2;
    }
    // removeAll — removes all matching occurrences
    match /removeAllManyAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.removeAll(['b']).size() == 2;
    }
    // removeAll — empty arg → identity
    match /removeAllEmptyAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.removeAll([]).size() == 3;
    }
    // toSet — dedupes
    match /toSetAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.toSet().size() == 3;
    }
    // toSet — chains to Set.difference (5.1 + 5.2 wiring)
    match /toSetChainAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.toSet().difference(['a']).hasOnly(['b','c']);
    }
    // DENY witness — concat with wrong expected size
    match /concatDeny/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.concat(['c']).size() == 99;
    }
${listMethodBlocks}
  }
}`,
  cases: [
    {
      description: 'list concat → size 4 ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'concatAllow/d1',
      auth: { uid: 'alice' },
      data: { a: ['x', 'y'], b: ['p', 'q'] },
    },
    {
      description: 'list concat preserves order ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'concatOrderAllow/d2',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b'] },
    },
    {
      description: 'list concat does NOT dedupe ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'concatNoDedupAllow/d3',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b'] },
    },
    {
      description: 'list removeAll basic ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'removeAllAllow/d4',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b', 'c'] },
    },
    {
      description: 'list removeAll removes all occurrences ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'removeAllManyAllow/d5',
      auth: { uid: 'alice' },
      data: { a: ['b', 'a', 'b', 'c'] },
    },
    {
      description: 'list removeAll empty arg → identity ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'removeAllEmptyAllow/d6',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b', 'c'] },
    },
    {
      description: 'list toSet dedupes ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'toSetAllow/d7',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b', 'c', 'a', 'b'] },
    },
    {
      description: 'list toSet().difference chain (5.1 wiring) DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'toSetChainAllow/d8',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b', 'c', 'a'] },
    },
    {
      description: 'list concat with wrong expected size DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'concatDeny/d9',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b'] },
    },
    ...listMethodCases.map(([description, , expectation], index) => ({
      description: `listMethod: ${description}`,
      expectation,
      method: 'create' as const,
      path: `listMethod/${index}/d1`,
      auth: { uid: 'alice' },
      data: {},
    })),
  ],
  group: 'stress',
};
