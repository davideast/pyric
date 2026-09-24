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
 * `constructor` and `toString` pin that a diff reads own keys only.
 */
import type { StorageScenarioRecord } from './types.ts';

const REQUEST_TIME = '2025-06-15T00:00:00Z';

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
  ],
};
