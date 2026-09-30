/**
 * P2 discovery probe for candidate Storage-native stdlib primitives. One
 * batched Rules Test API request covers the boundaries that helpers would
 * otherwise be tempted to guess: inclusive size limits, MIME exactness,
 * metadata key/default methods, unchanged bytes during metadata updates,
 * path wildcard typing, object identity, and strict time windows. The
 * `keys-*` matches show custom-metadata `keys()` returns a List: `is list`
 * holds, `is set` is false, and `toSet()`, `hasAll()`, `hasAny()`,
 * `hasOnly()`, `size()`, `[0]` and `join()` evaluate on it.
 *
 * The `list-*` matches cover each List method on the keys() List and on
 * List literals: `toSet()`, `join()`, `hasAll()`, `hasAny()`,
 * `hasOnly()`, `concat()` and `removeAll()`, each with a value case, a
 * `!=` witness and error cases. An error case negates a comparison that is
 * false when the call succeeds, so ALLOW would show a value and DENY shows
 * the error. A List receiver takes only a List argument, where a Set
 * argument is an error; a Set receiver's `hasAny()` and `hasOnly()`
 * take either. `join()` converts each element as `string()` does.
 *
 * List membership (`in`, `hasAny()`, `hasAll()`, `hasOnly()`) and
 * `removeAll()` compare an element's numeric type: an int is not a member of
 * a List of the equal float, `-0.0` is a member of `[0.0]`, and NaN is a
 * member of nothing. A List method on a string, Map or Set receiver is
 * "Function not found error". `keys()` lists a Map's keys in ascending
 * Unicode code point order, for Map literals and for custom metadata alike.
 * `values()` lists a Map literal's values in the order written, a repeated
 * key keeping its first position and last value, and custom metadata values
 * in the order the request sent them. `keys()` and `values()` take no
 * argument, and a List or string receiver of `keys()`, `values()` or `get()`
 * is "Function not found error". A List receiver's `hasAll()`, `hasAny()` and
 * `hasOnly()` take one List argument; a Map or null argument is an
 * unsupported operation and another argument count is "Incorrect number of
 * arguments".
 */
import type { StorageScenarioRecord } from './types.ts';

/** One List-method case: description, allow condition, production verdict. */
type ListMethodCase = readonly [description: string, condition: string, expectation: 'ALLOW' | 'DENY'];

const LIST_METHOD_CASES: readonly ListMethodCase[] = [
  ['toSet: keys().toSet() equals a Set literal in another order', "request.resource.metadata.keys().toSet() == ['b', 'a'].toSet()", 'ALLOW'],
  ['toSet: a List literal with a duplicate equals the distinct Set', "['a', 'a', 'b'].toSet() == ['b', 'a'].toSet()", 'ALLOW'],
  ['toSet: != a smaller Set is true', "request.resource.metadata.keys().toSet() != ['a'].toSet()", 'ALLOW'],
  ['toSet: != the same Set is false', "['a'].toSet() != ['a', 'a'].toSet()", 'DENY'],
  ['toSet: a Set receiver is an error', "!(['a'].toSet().toSet() == ['z'].toSet())", 'DENY'],
  ['toSet: a Map receiver is an error', "!(request.resource.metadata.toSet() == ['z'].toSet())", 'DENY'],
  ['toSet: an argument is an error', "!(['a'].toSet(1) == ['z'].toSet())", 'DENY'],
  ['join: keys().join() joins the keys', "request.resource.metadata.keys().join(',') == 'a,b'", 'ALLOW'],
  ['join: a List literal joins with the separator', "['a', 'b'].join('-') == 'a-b'", 'ALLOW'],
  ['join: != another string is true', "request.resource.metadata.keys().join(',') != 'a'", 'ALLOW'],
  ['join: an empty List joins to the empty string', "[].join(',') == ''", 'ALLOW'],
  ['join: int, bool and null elements convert as string() does', "['a', 1, true, null].join('|') == 'a|1|true|null'", 'ALLOW'],
  ['join: float elements convert as string() does', "[2.0, -0.5].join(',') == '2.0,-0.5'", 'ALLOW'],
  ['join: a List element is an error', "!([['a']].join(',') == 'z')", 'DENY'],
  ['join: an int separator is an error', "!(['a', 'b'].join(1) == 'z')", 'DENY'],
  ['join: no separator is an error', "!(['a', 'b'].join() == 'z')", 'DENY'],
  ['join: a Set receiver is an error', "!(['a'].toSet().join(',') == 'z')", 'DENY'],
  ['hasAll: a Set argument to a List receiver is an error', "!(['a', 'b'].hasAll(['z'].toSet()))", 'DENY'],
  ['hasAny: keys().hasAny() with one shared key', "request.resource.metadata.keys().hasAny(['z', 'b'])", 'ALLOW'],
  ['hasAny: a List literal with one shared element', "['a', 'b'].hasAny(['b'])", 'ALLOW'],
  ['hasAny: != true with no shared key', "request.resource.metadata.keys().hasAny(['z']) != true", 'ALLOW'],
  ['hasAny: an empty argument is false', "!['a'].hasAny([])", 'ALLOW'],
  ['hasAny: a Set receiver takes a Set argument', "request.resource.metadata.keys().toSet().hasAny(['b'].toSet())", 'ALLOW'],
  ['hasAny: a Set argument to a List receiver is an error', "!(['a', 'b'].hasAny(['z'].toSet()))", 'DENY'],
  ['hasAny: a string argument is an error', "!(['a', 'b'].hasAny('z'))", 'DENY'],
  ['hasAny: a Map receiver is an error', "!(request.resource.metadata.hasAny(['z']))", 'DENY'],
  ['hasOnly: keys().hasOnly() is false for a missing key', "!request.resource.metadata.keys().hasOnly(['a'])", 'ALLOW'],
  ['hasOnly: a List literal with a duplicate', "['a', 'a'].hasOnly(['a'])", 'ALLOW'],
  ['hasOnly: != true for a missing key', "request.resource.metadata.keys().hasOnly(['a']) != true", 'ALLOW'],
  ['hasOnly: an empty receiver is true', '[].hasOnly([])', 'ALLOW'],
  ['hasOnly: a Set receiver takes a Set argument', "request.resource.metadata.keys().toSet().hasOnly(['a', 'b'].toSet())", 'ALLOW'],
  ['hasOnly: a Set argument to a List receiver is an error', "!(['a', 'b'].hasOnly(['z'].toSet()))", 'DENY'],
  ['hasOnly: a string argument is an error', "!(['a'].hasOnly('z'))", 'DENY'],
  ['concat: keys().concat() appends the argument', "request.resource.metadata.keys().concat(['c']) == ['a', 'b', 'c']", 'ALLOW'],
  ['concat: a List literal keeps duplicates in order', "['x'].concat(['y', 'x']) == ['x', 'y', 'x']", 'ALLOW'],
  ['concat: != the receiver is true', "request.resource.metadata.keys().concat(['c']) != ['a', 'b']", 'ALLOW'],
  ['concat: keys() with itself has four elements', 'request.resource.metadata.keys().concat(request.resource.metadata.keys()).size() == 4', 'ALLOW'],
  ['concat: two empty Lists', '[].concat([]) == []', 'ALLOW'],
  ['concat: a string argument is an error', "!(['a'].concat('b') == ['z'])", 'DENY'],
  ['concat: a Set argument is an error', "!(['a'].concat(['b'].toSet()) == ['z'])", 'DENY'],
  ['concat: a Set receiver is an error', "!(['a'].toSet().concat(['b']) == ['z'])", 'DENY'],
  ['concat: a string receiver is an error', "!('a'.concat('b') == 'z')", 'DENY'],
  ['concat: no argument is an error', "!(['a'].concat() == ['z'])", 'DENY'],
  ['removeAll: keys().removeAll() drops the listed key', "request.resource.metadata.keys().removeAll(['a']) == ['b']", 'ALLOW'],
  ['removeAll: a List literal drops every occurrence', "['a', 'b', 'a', 'c'].removeAll(['a', 'c']) == ['b']", 'ALLOW'],
  ['removeAll: != the receiver is true', "request.resource.metadata.keys().removeAll(['a']) != ['a', 'b']", 'ALLOW'],
  ['removeAll: an absent element leaves the List unchanged', "['a', 'b'].removeAll(['z']) == ['a', 'b']", 'ALLOW'],
  ['removeAll: List, Map and null elements compare by value', "[['a'], {'k': 'v'}, null].removeAll([['a'], null]) == [{'k': 'v'}]", 'ALLOW'],
  ['removeAll: a string argument is an error', "!(['a'].removeAll('a') == ['z'])", 'DENY'],
  ['removeAll: a Set argument is an error', "!(['a', 'b'].removeAll(['a'].toSet()) == ['z'])", 'DENY'],
  ['removeAll: a Set receiver is an error', "!(['a'].toSet().removeAll(['a']) == ['z'].toSet())", 'DENY'],
  ['removeAll: a Map receiver is an error', "!(request.resource.metadata.removeAll(['a']) == ['z'])", 'DENY'],
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
  ['join: != the joined string is false', "['a', 'b'].join(',') != 'a,b'", 'DENY'],
  ['join: || true absorbs the no-separator error', "(['a', 'b'].join() == 'z') || true", 'ALLOW'],
  ['join: two separators is an error', "!(['a'].join(',', ',') == 'z')", 'DENY'],
  ['join: a null element is not the empty string', "['a', null].join(',') == 'a,'", 'DENY'],
  ['join: a float element is not printed as an int', "[2.0].join(',') == '2'", 'DENY'],
  ['join: floats convert as string() does', "[-0.5, 100000000.0, 1.5].join(',') == '-0.5,1.0E8,1.5'", 'ALLOW'],
  ['join: a path element converts as string() does', "[path('/a/b')].join(',') == '/a/b'", 'ALLOW'],
  ['join: || true absorbs a List element error', "([['a']].join(',') == 'z') || true", 'ALLOW'],
  ['join: a Map element is an error', "!([{'k': 'v'}].join(',') == 'z')", 'DENY'],
  ['join: a bytes element is an error', "!([b'ab'].join(',') == 'z')", 'DENY'],
  ['join: a duration element is an error', "!([duration.value(1, 's')].join(',') == 'z')", 'DENY'],
  ['join: an empty separator', "['a', 'b'].join('') == 'ab'", 'ALLOW'],
  ['receiver: || true absorbs concat on a string', "('a'.concat('b') == 'z') || true", 'ALLOW'],
  ['receiver: removeAll on a string is an error', "!('a'.removeAll(['a']) == 'z')", 'DENY'],
  ['receiver: join on a string is an error', "!('a'.join(',') == 'z')", 'DENY'],
  ['receiver: toSet on a string is an error', "!('a'.toSet() == ['a'].toSet())", 'DENY'],
  ['receiver: hasAny on a string is an error', "!('a'.hasAny(['a']))", 'DENY'],
  ['receiver: hasAll on a string is an error', "!('a'.hasAll(['a']))", 'DENY'],
  ['receiver: hasOnly on a string is an error', "!('a'.hasOnly(['a']))", 'DENY'],
  ['receiver: concat on a Map is an error', "!({'a': 1}.concat([1]) == [1])", 'DENY'],
  ['receiver: join on a Map is an error', "!({'a': 1}.join(',') == 'z')", 'DENY'],
  ['receiver: hasAll on a Map is an error', "!({'a': 1}.hasAll(['a']))", 'DENY'],
  ["keys: keys() of a literal is sorted", "{'b': 1, 'a': 2}.keys() == ['a', 'b']", 'ALLOW'],
  ["keys: keys() of a literal is not in written order", "{'b': 1, 'a': 2}.keys() == ['b', 'a']", 'DENY'],
  ["keys: keys() != the sorted List is false", "{'b': 1, 'a': 2}.keys() != ['a', 'b']", 'DENY'],
  ["keys: keys()[0] is the least key", "{'b': 1, 'a': 2}.keys()[0] == 'a'", 'ALLOW'],
  ["keys: keys().join() joins the sorted keys", "{'b': 1, 'a': 2}.keys().join(',') == 'a,b'", 'ALLOW'],
  [
    "keys: keys() orders digits, upper case, underscore and lower case by code point",
    "{'b': 1, 'B': 2, 'a': 3, 'A': 4, '10': 5, '2': 6, '1': 7, '_': 8, 'z': 9}.keys() == ['1', '10', '2', 'A', 'B', '_', 'a', 'b', 'z']",
    'ALLOW',
  ],
  [
    "keys: keys() does not order numeric keys by value",
    "{'b': 1, 'B': 2, 'a': 3, 'A': 4, '10': 5, '2': 6, '1': 7, '_': 8, 'z': 9}.keys() == ['1', '2', '10', 'A', 'B', '_', 'a', 'b', 'z']",
    'DENY',
  ],
  ["keys: keys() puts '10' before '9'", "{'b': 1, '10': 2, '9': 3}.keys() == ['10', '9', 'b']", 'ALLOW'],
  ["keys: keys() orders non-ASCII keys by code point", "{'é': 1, 'z': 2, 'ｚ': 3, '😀': 4, 'e': 5}.keys() == ['e', 'z', 'é', 'ｚ', '😀']", 'ALLOW'],
  ["keys: keys() does not order by UTF-16 code unit", "{'é': 1, 'z': 2, 'ｚ': 3, '😀': 4, 'e': 5}.keys() == ['e', 'z', 'é', '😀', 'ｚ']", 'DENY'],
  ["keys: keys() puts a prefix before its extensions", "{'ab': 1, 'a': 2, 'a b': 3, '': 4}.keys() == ['', 'a', 'a b', 'ab']", 'ALLOW'],
  ["values: values() keeps the written order", "{'c': 3, 'a': 1, 'b': 2}.values() == [3, 1, 2]", 'ALLOW'],
  ["values: values() is not in key order", "{'c': 3, 'a': 1, 'b': 2}.values() == [1, 2, 3]", 'DENY'],
  ["values: values() keeps an integer-like key in written order", "{'b': 1, '1': 2}.values() == [1, 2]", 'ALLOW'],
  ["values: values() does not put an integer-like key first", "{'b': 1, '1': 2}.values() == [2, 1]", 'DENY'],
  ["values: values() != the written order is false", "{'b': 1, '1': 2}.values() != [1, 2]", 'DENY'],
  ["values: values() keeps '10' and '9' in written order", "{'b': 1, '10': 2, '9': 3}.values() == [1, 2, 3]", 'ALLOW'],
  [
    "values: values() keeps non-ASCII, integer-like and empty keys in written order",
    "{'z': 1, 'é': 2, '😀': 3, 'ｚ': 4, '10': 5, '9': 6, '': 7}.values() == [1, 2, 3, 4, 5, 6, 7]",
    'ALLOW',
  ],
  ["values: values() of a nested literal keeps its written order", "{'x': {'b': 1, '1': 2}}.x.values() == [1, 2]", 'ALLOW'],
  ["values: values()[0] is the first value written", "{'b': 1, 'a': 2}.values()[0] == 1", 'ALLOW'],
  ["values: values().join() joins in written order", "{'b': 1, 'a': 2}.values().join(',') == '1,2'", 'ALLOW'],
  ["values: values() of a repeated key keeps its first position and last value", "{'a': 1, 'b': 2, 'a': 3}.values() == [3, 2]", 'ALLOW'],
  ["values: values() of a repeated key does not move it last", "{'a': 1, 'b': 2, 'a': 3}.values() == [2, 3]", 'DENY'],
  ["values: values() of an empty Map is an empty List", '{}.values() == []', 'ALLOW'],
  ["values: values() is list", "{'b': 1, 'a': 2}.values() is list", 'ALLOW'],
  ["values: values() with an argument is an error", "!({'a': 1}.values(1) == [1])", 'DENY'],
  ["values: || true absorbs values() with an argument", "({'a': 1}.values(1) == [1]) || true", 'ALLOW'],
  ["values: keys() with an argument is an error", "!({'a': 1}.keys(1) == ['a'])", 'DENY'],
  ["values: values() on a List is an error", '!([1].values() == [1])', 'DENY'],
  ["values: values() on a string is an error", "!('a'.values() == ['a'])", 'DENY'],
  ["values: keys() on a List is an error", '!([1].keys() == [1])', 'DENY'],
  ["values: keys() on a string is an error", "!('a'.keys() == ['a'])", 'DENY'],
  ["values: get() on a List is an error", '!([1].get(0, 1) == 9)', 'DENY'],
  ['argument: hasAll with a List argument', "['a', 'b'].hasAll(['b', 'a'])", 'ALLOW'],
  ['argument: hasAll != false with a missing element', "['a', 'b'].hasAll(['a', 'z']) != false", 'DENY'],
  ['argument: || true absorbs a Set argument to hasAny on a List', "(['a', 'b'].hasAny(['z'].toSet())) || true", 'ALLOW'],
  ['argument: a Map argument to hasAll is an error', "!([1, 2].hasAll({'a': 1}))", 'DENY'],
  ['argument: a null argument to hasOnly is an error', '!([1, 2].hasOnly(null))', 'DENY'],
  ['argument: || true absorbs a string argument to hasAll', "([1, 2].hasAll('a')) || true", 'ALLOW'],
  ['argument: hasAny with no argument is an error', '!([1, 2].hasAny())', 'DENY'],
  ['argument: hasAll with two arguments is an error', '!([1, 2].hasAll([1], [2]))', 'DENY'],
];

/**
 * One metadata keys() or values() order case, with metadata written as
 * `{b, a, B, 1}`. The request carries the keys in JavaScript property order,
 * `1` first, which is the order `values()` returns.
 */
const METADATA_KEY_ORDER_CASES: readonly ListMethodCase[] = [
  ['metadata keys() is sorted', "request.resource.metadata.keys() == ['1', 'B', 'a', 'b']", 'ALLOW'],
  ['metadata keys() is not in written order', "request.resource.metadata.keys() == ['b', 'a', 'B', '1']", 'DENY'],
  ['metadata keys()[0] is the least key', "request.resource.metadata.keys()[0] == '1'", 'ALLOW'],
  ['metadata keys().join() joins the sorted keys', "request.resource.metadata.keys().join(',') == '1,B,a,b'", 'ALLOW'],
  ['metadata values() keeps the order the request sent', "request.resource.metadata.values() == ['w', 'y', 'x', 'z']", 'ALLOW'],
  ['metadata values() is not in key order', "request.resource.metadata.values() == ['w', 'z', 'x', 'y']", 'DENY'],
  ['metadata values()[0] is the first value sent', "request.resource.metadata.values()[0] == 'w'", 'ALLOW'],
];

const metadataKeyOrderMatches = METADATA_KEY_ORDER_CASES.map(([, condition], index) =>
  `    match /metadata-key-order-${index}/{fileName} {
      allow create: if ${condition};
    }`).join('\n');

const listMethodMatches = LIST_METHOD_CASES.map(([, condition], index) =>
  `    match /list-${index}/{fileName} {
      allow create: if ${condition};
    }`).join('\n');

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-P2-PRIMITIVES',
  rationale:
    'Boundary-first evidence for Storage size, MIME, metadata, path, identity, and time helpers, including production-pinned metadata collection methods.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function sizeAtMost(maxBytes) {
      return request.resource.size <= maxBytes;
    }
    function mimeIs(expected) {
      return request.resource.contentType == expected;
    }
    function hasMetadata(required) {
      return request.resource.metadata.keys().hasAll(required);
    }
    function metadataOr(key, fallback) {
      return request.resource.metadata.get(key, fallback);
    }
    function createdWithin(seconds) {
      return request.time < resource.timeCreated + duration.value(seconds, 's');
    }

    match /size/{fileName} {
      allow create: if sizeAtMost(10);
    }
    match /mime-exact/{fileName} {
      allow create: if mimeIs('image/png');
    }
    match /mime-regex/{fileName} {
      allow create: if request.resource.contentType.matches('image/(png|jpeg)');
    }
    match /metadata-required/{fileName} {
      allow create: if hasMetadata(['owner', 'purpose']);
    }
    match /metadata-default/{fileName} {
      allow create: if metadataOr('visibility', 'private') == 'private';
    }
    match /metadata-update/{fileName} {
      allow update: if request.resource.size == resource.size
        && request.resource.metadata.owner == resource.metadata.owner;
    }
    match /path/{fileName} {
      allow create: if fileName is string && fileName.matches('.*[.]png');
    }
    match /identity/{fileName} {
      allow get: if resource.name == 'identity/pinned.png'
        && resource.bucket == bucket
        && resource.generation == 7
        && resource.metageneration == 2;
    }
    match /fresh/{fileName} {
      allow delete: if createdWithin(60);
    }
    match /request-resource-delete/{fileName} {
      allow delete: if request.resource == null;
    }
    // keys() returns a List: each List method and type test on it
    match /keys-to-set/{fileName} {
      allow create: if request.resource.metadata.keys().toSet() == ['a', 'b'].toSet();
    }
    match /keys-has-all/{fileName} {
      allow create: if request.resource.metadata.keys().hasAll(['a', 'b']);
    }
    match /keys-size/{fileName} {
      allow create: if request.resource.metadata.keys().size() == 2;
    }
    match /keys-index/{fileName} {
      allow create: if request.resource.metadata.keys()[0] == 'a';
    }
    match /keys-join/{fileName} {
      allow create: if request.resource.metadata.keys().join(',') == 'a';
    }
    match /keys-has-any/{fileName} {
      allow create: if request.resource.metadata.keys().hasAny(['a', 'z']);
    }
    match /keys-has-only/{fileName} {
      allow create: if request.resource.metadata.keys().hasOnly(['a', 'b', 'c']);
    }
    match /keys-is-list/{fileName} {
      allow create: if request.resource.metadata.keys() is list;
    }
    match /keys-is-set/{fileName} {
      allow create: if request.resource.metadata.keys() is set;
    }
    match /keys-is-not-set/{fileName} {
      allow create: if !(request.resource.metadata.keys() is set);
    }
    match /keys-to-set-size/{fileName} {
      allow create: if request.resource.metadata.keys().toSet().size() == 2;
    }
    // List methods on keys() and on List literals
${listMethodMatches}
    // keys() order over custom metadata
${metadataKeyOrderMatches}
  }
}`,
  cases: [
    { description: 'size: zero bytes is within inclusive maximum', expectation: 'ALLOW', method: 'create', path: 'size/zero.bin', resource: { size: 0 } },
    { description: 'size: exact maximum is allowed', expectation: 'ALLOW', method: 'create', path: 'size/exact.bin', resource: { size: 10 } },
    { description: 'size: maximum plus one is denied', expectation: 'DENY', method: 'create', path: 'size/large.bin', resource: { size: 11 } },

    { description: 'MIME exact: image/png is allowed', expectation: 'ALLOW', method: 'create', path: 'mime-exact/a.png', resource: { size: 1, contentType: 'image/png' } },
    { description: 'MIME exact: case difference is denied', expectation: 'DENY', method: 'create', path: 'mime-exact/a.png', resource: { size: 1, contentType: 'Image/PNG' } },
    { description: 'MIME exact: parameterized value is denied', expectation: 'DENY', method: 'create', path: 'mime-exact/a.png', resource: { size: 1, contentType: 'image/png; charset=binary' } },
    { description: 'MIME regex: image/jpeg whole value is allowed', expectation: 'ALLOW', method: 'create', path: 'mime-regex/a.jpg', resource: { size: 1, contentType: 'image/jpeg' } },
    { description: 'MIME regex: suffix defeats whole-string match', expectation: 'DENY', method: 'create', path: 'mime-regex/a.jpg', resource: { size: 1, contentType: 'image/jpeg-extra' } },

    { description: 'metadata keys: required keys with an extra key are allowed', expectation: 'ALLOW', method: 'create', path: 'metadata-required/a.bin', resource: { size: 1, metadata: { owner: 'alice', purpose: 'avatar', extra: 'ok' } } },
    { description: 'metadata keys: missing required key is denied', expectation: 'DENY', method: 'create', path: 'metadata-required/a.bin', resource: { size: 1, metadata: { owner: 'alice' } } },
    { description: 'metadata keys: absent metadata map is denied', expectation: 'DENY', method: 'create', path: 'metadata-required/a.bin', resource: { size: 1 } },
    { description: 'metadata get: missing key returns supplied default', expectation: 'ALLOW', method: 'create', path: 'metadata-default/a.bin', resource: { size: 1, metadata: {} } },
    { description: 'metadata get: present non-default value is denied', expectation: 'DENY', method: 'create', path: 'metadata-default/a.bin', resource: { size: 1, metadata: { visibility: 'public' } } },

    { description: 'metadata update: unchanged bytes and owner are allowed', expectation: 'ALLOW', method: 'update', path: 'metadata-update/a.bin', resource: { size: 8, metadata: { owner: 'alice', label: 'new' } }, existingResource: { size: 8, metadata: { owner: 'alice', label: 'old' } } },
    { description: 'metadata update: changed byte size is denied', expectation: 'DENY', method: 'update', path: 'metadata-update/a.bin', resource: { size: 9, metadata: { owner: 'alice' } }, existingResource: { size: 8, metadata: { owner: 'alice' } } },
    { description: 'metadata update: changed owner is denied', expectation: 'DENY', method: 'update', path: 'metadata-update/a.bin', resource: { size: 8, metadata: { owner: 'bob' } }, existingResource: { size: 8, metadata: { owner: 'alice' } } },

    { description: 'path wildcard: string png filename is allowed', expectation: 'ALLOW', method: 'create', path: 'path/photo.png', resource: { size: 1 } },
    { description: 'path wildcard: non-png filename is denied', expectation: 'DENY', method: 'create', path: 'path/photo.jpg', resource: { size: 1 } },

    { description: 'identity: exact name bucket generation and metageneration are allowed', expectation: 'ALLOW', method: 'get', path: 'identity/pinned.png', existingResource: { size: 1, name: 'identity/pinned.png', bucket: 'demo-pyric.appspot.com', generation: 7, metageneration: 2 } },
    { description: 'identity: generation mismatch is denied', expectation: 'DENY', method: 'get', path: 'identity/pinned.png', existingResource: { size: 1, name: 'identity/pinned.png', bucket: 'demo-pyric.appspot.com', generation: 8, metageneration: 2 } },
    { description: 'identity: absent generation is denied', expectation: 'DENY', method: 'get', path: 'identity/pinned.png', existingResource: { size: 1, name: 'identity/pinned.png', bucket: 'demo-pyric.appspot.com', metageneration: 2 } },

    { description: 'time: one millisecond before strict 60 second boundary is allowed', expectation: 'ALLOW', method: 'delete', path: 'fresh/a.bin', requestTime: '2025-03-01T00:00:59.999Z', existingResource: { size: 1, timeCreated: '2025-03-01T00:00:00Z' } },
    { description: 'time: exact strict 60 second boundary is denied', expectation: 'DENY', method: 'delete', path: 'fresh/a.bin', requestTime: '2025-03-01T00:01:00Z', existingResource: { size: 1, timeCreated: '2025-03-01T00:00:00Z' } },
    { description: 'time: after strict 60 second boundary is denied', expectation: 'DENY', method: 'delete', path: 'fresh/a.bin', requestTime: '2025-03-01T00:01:00.001Z', existingResource: { size: 1, timeCreated: '2025-03-01T00:00:00Z' } },
    { description: 'time: future timeCreated value makes the strict comparison true', expectation: 'ALLOW', method: 'delete', path: 'fresh/a.bin', requestTime: '2025-03-01T00:00:00Z', existingResource: { size: 1, timeCreated: '2025-03-01T00:01:00Z' } },
    { description: 'delete: missing request.resource does not become a usable null guard', expectation: 'DENY', method: 'delete', path: 'request-resource-delete/a.bin', existingResource: { size: 1 } },

    { description: 'keys: toSet() equals a set of the metadata keys', expectation: 'ALLOW', method: 'create', path: 'keys-to-set/a.bin', resource: { size: 1, metadata: { a: 'x', b: 'y' } } },
    { description: 'keys: hasAll() with a List argument', expectation: 'ALLOW', method: 'create', path: 'keys-has-all/a.bin', resource: { size: 1, metadata: { a: 'x', b: 'y' } } },
    { description: 'keys: size() counts the metadata keys', expectation: 'ALLOW', method: 'create', path: 'keys-size/a.bin', resource: { size: 1, metadata: { a: 'x', b: 'y' } } },
    { description: 'keys: [0] is the only metadata key', expectation: 'ALLOW', method: 'create', path: 'keys-index/a.bin', resource: { size: 1, metadata: { a: 'x' } } },
    { description: 'keys: join() joins the metadata keys', expectation: 'ALLOW', method: 'create', path: 'keys-join/a.bin', resource: { size: 1, metadata: { a: 'x' } } },
    { description: 'keys: hasAny()', expectation: 'ALLOW', method: 'create', path: 'keys-has-any/a.bin', resource: { size: 1, metadata: { a: 'x', b: 'y' } } },
    { description: 'keys: hasOnly()', expectation: 'ALLOW', method: 'create', path: 'keys-has-only/a.bin', resource: { size: 1, metadata: { a: 'x', b: 'y' } } },
    { description: 'keys: keys() is list', expectation: 'ALLOW', method: 'create', path: 'keys-is-list/a.bin', resource: { size: 1, metadata: { a: 'x', b: 'y' } } },
    { description: 'keys: keys() is set is false', expectation: 'DENY', method: 'create', path: 'keys-is-set/a.bin', resource: { size: 1, metadata: { a: 'x', b: 'y' } } },
    { description: 'keys: !(keys() is set)', expectation: 'ALLOW', method: 'create', path: 'keys-is-not-set/a.bin', resource: { size: 1, metadata: { a: 'x', b: 'y' } } },
    { description: 'keys: toSet().size()', expectation: 'ALLOW', method: 'create', path: 'keys-to-set-size/a.bin', resource: { size: 1, metadata: { a: 'x', b: 'y' } } },
    ...LIST_METHOD_CASES.map(([description, , expectation], index) => ({
      description: `list: ${description}`,
      expectation,
      method: 'create' as const,
      path: `list-${index}/a.bin`,
      resource: { size: 1, metadata: { a: 'x', b: 'y' } },
    })),
    ...METADATA_KEY_ORDER_CASES.map(([description, , expectation], index) => ({
      description: `keys order: ${description}`,
      expectation,
      method: 'create' as const,
      path: `metadata-key-order-${index}/a.bin`,
      resource: { size: 1, metadata: { b: 'y', a: 'x', B: 'z', 1: 'w' } },
    })),
  ],
};
