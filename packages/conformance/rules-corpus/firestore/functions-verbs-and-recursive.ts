/**
 * ─── Scenario: functions-verbs-and-recursive ──────────────────────────────────
 * The rule-structure surface: user-defined `function` declarations with `let`
 * bindings, the granular `allow get` / `allow list` / `allow update` /
 * `allow write` verbs, the ternary operator, and a recursive `{document=**}`
 * wildcard match. A role-gated `docs` collection plus a public recursive
 * subtree — the structural constructs a real ruleset is built from.
 *
 * Function parameters and field values are untyped at compile time. A method
 * called on a parameter, on a field of a get() result, on a let bound to
 * request data, or on a ternary whose branches have different types compiles;
 * the runtime value decides, and a method it does not support denies. These
 * are the plain v2 shapes that `2+modules` module functions lower to.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Coverage: functions/let, granular verbs, ternary, recursive wildcard, methods on untyped receivers',
  rationale:
    'Production must accept function declarations with let bindings, allow get/list/update/write verbs, the ternary operator, and a recursive {document=**} match, and must compile method calls on receivers whose type is known only at evaluation.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isSignedIn() {
      return request.auth != null;
    }
    function roleLevel() {
      let base = isSignedIn() ? 1 : 0;
      let boosted = base * 2;
      return boosted;
    }
    function seated(game) {
      return game.players.size() == 2;
    }
    function inBounds(shot) {
      return shot.keys().hasOnly(['dx', 'dy']);
    }
    function relay(value) {
      return inBounds(value);
    }
    function boardHasOrigin() {
      let doc = request.resource.data;
      return doc.board.keys().hasAll(['a1']);
    }
    match /docs/{docId} {
      allow get: if isSignedIn();
      allow list: if isSignedIn() && roleLevel() >= 2;
      allow update: if isSignedIn() && roleLevel() >= 2;
      allow write: if isSignedIn() && roleLevel() >= 2;
    }
    match /trees/{treeId}/{document=**} {
      allow read: if isSignedIn();
    }
    // a get() result passed as a parameter; the function calls a method on its field
    match /seated/{id} {
      allow create: if seated(get(/databases/$(database)/documents/lobbies/main).data);
    }
    // a method called directly on a field of a get() result
    match /getField/{id} {
      allow create: if get(/databases/$(database)/documents/lobbies/main).data.players.size() == 2;
    }
    // a map field passed as a parameter
    match /mapParam/{id} {
      allow create: if inBounds(request.resource.data.shot);
    }
    // a parameter passed on from one function to another
    match /relayed/{id} {
      allow create: if relay(request.resource.data.shot);
    }
    // a let bound to request data
    match /letDoc/{id} {
      allow create: if boardHasOrigin();
    }
    // a ternary whose branches are a map and a string; both support size()
    match /ternarySize/{id} {
      allow create: if (request.resource.data.useMap ? {'a': 1, 'b': 2} : 'ab').size() == 2;
    }
    // a ternary whose string branch does not support keys()
    match /ternaryKeys/{id} {
      allow create: if (request.resource.data.useMap ? {'a': 1} : 'a').keys().size() == 1;
    }
  }
}`,
  cases: [
    {
      description: 'signed-in get ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'docs/d1',
      auth: { uid: 'alice' },
      resource: { title: 'X' },
    },
    {
      description: 'anonymous get DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'docs/d1',
      auth: null,
      resource: { title: 'X' },
    },
    {
      description: 'signed-in list with roleLevel 2 ALLOW (let + ternary + mul)',
      expectation: 'ALLOW',
      method: 'list',
      path: 'docs/d1',
      auth: { uid: 'alice' },
    },
    {
      description: 'signed-in update with roleLevel 2 ALLOW',
      expectation: 'ALLOW',
      method: 'update',
      path: 'docs/d2',
      auth: { uid: 'alice' },
      resource: { title: 'Old' },
      data: { title: 'New' },
    },
    {
      description: 'signed-in create covered by write grant ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'docs/d3',
      auth: { uid: 'alice' },
      data: { title: 'New' },
    },
    {
      description: 'recursive subtree read when signed-in ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'trees/t1/a/b/c',
      auth: { uid: 'alice' },
      resource: { leaf: true },
    },
    {
      description: 'recursive subtree read denied when anonymous DENY',
      expectation: 'DENY',
      method: 'get',
      path: 'trees/t1/a/b/c',
      auth: null,
      resource: { leaf: true },
    },
    {
      description: 'get() result parameter with a list field ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'seated/g1',
      auth: { uid: 'alice' },
      data: {},
      functionMocks: [
        { function: 'get', path: 'lobbies/main', result: { players: ['alice', 'bob'] } },
      ],
    },
    {
      description: 'get() result parameter with an int field DENY (int has no size())',
      expectation: 'DENY',
      method: 'create',
      path: 'seated/g2',
      auth: { uid: 'alice' },
      data: {},
      functionMocks: [
        { function: 'get', path: 'lobbies/main', result: { players: 2 } },
      ],
    },
    {
      description: 'method on a get() field ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'getField/g1',
      auth: { uid: 'alice' },
      data: {},
      functionMocks: [
        { function: 'get', path: 'lobbies/main', result: { players: ['alice', 'bob'] } },
      ],
    },
    {
      description: 'map field parameter ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'mapParam/m1',
      auth: { uid: 'alice' },
      data: { shot: { dx: 1, dy: 2 } },
    },
    {
      description: 'string field parameter DENY (string has no keys())',
      expectation: 'DENY',
      method: 'create',
      path: 'mapParam/m2',
      auth: { uid: 'alice' },
      data: { shot: 'dx' },
    },
    {
      description: 'parameter relayed between functions ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'relayed/r1',
      auth: { uid: 'alice' },
      data: { shot: { dx: 1, dy: 2 } },
    },
    {
      description: 'int parameter relayed between functions DENY (int has no keys())',
      expectation: 'DENY',
      method: 'create',
      path: 'relayed/r2',
      auth: { uid: 'alice' },
      data: { shot: 5 },
    },
    {
      description: 'let-bound document with a map field ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'letDoc/l1',
      auth: { uid: 'alice' },
      data: { board: { a1: 'x' } },
    },
    {
      description: 'let-bound document with a list field DENY (list has no keys())',
      expectation: 'DENY',
      method: 'create',
      path: 'letDoc/l2',
      auth: { uid: 'alice' },
      data: { board: ['a1'] },
    },
    {
      description: 'ternary map branch size() ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'ternarySize/t1',
      auth: { uid: 'alice' },
      data: { useMap: true },
    },
    {
      description: 'ternary string branch size() ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'ternarySize/t2',
      auth: { uid: 'alice' },
      data: { useMap: false },
    },
    {
      description: 'ternary map branch keys() ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'ternaryKeys/t1',
      auth: { uid: 'alice' },
      data: { useMap: true },
    },
    {
      description: 'ternary string branch keys() DENY (string has no keys())',
      expectation: 'DENY',
      method: 'create',
      path: 'ternaryKeys/t2',
      auth: { uid: 'alice' },
      data: { useMap: false },
    },
  ],
  group: 'stress',
};
