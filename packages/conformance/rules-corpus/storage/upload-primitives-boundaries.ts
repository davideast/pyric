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
];

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
  ],
};
