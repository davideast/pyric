/**
 * Adversarial tests: scenarios designed to break the simulator.
 *
 * These test edge cases in expression evaluation that could cause
 * the simulator to diverge from production Firestore behavior.
 */
import { describe, test, expect } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules';
import type { TestCase } from 'pyric/rules';

const handler = new SimulateFirestoreRulesHandler();

function sim(source: string, cases: TestCase[]) {
  const r = handler.simulate(source, cases);
  expect(r.success).toBe(true);
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}

// ═══ Null chain propagation ═══

describe('null chain propagation', () => {

  const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow read: if true;
      allow update: if request.auth != null
          && resource.data[request.resource.data.moveFrom] != '';
    }
  }
}`;

  test('accessing missing field via dynamic key — null != empty string is true', () => {
    // resource.data['e2'] returns null (field missing). null != '' is TRUE in Firestore.
    // So this rule ALLOWS — the simulator must match this behavior.
    const r = sim(RULES, [{
      description: 'missing field via dynamic key — null != "" is true',
      expectation: 'ALLOW',
      method: 'update',
      path: 'test/doc1',
      auth: { uid: 'u1' },
      resource: {}, // no fields at all
      data: { moveFrom: 'e2' }, // e2 doesn't exist in resource → null, null != '' → true
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });

  test('double dynamic access where first level is null', () => {
    // resource.data[resource.data.moveFrom] where moveFrom points to nothing
    const RULES2 = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow update: if request.auth != null
          && resource.data[resource.data[request.resource.data.moveFrom]] == 'something';
    }
  }
}`;
    const r = sim(RULES2, [{
      description: 'double dynamic access, first level null',
      expectation: 'DENY',
      method: 'update',
      path: 'test/doc1',
      auth: { uid: 'u1' },
      resource: { moveFrom: 'e2' }, // e2 doesn't exist, so data[data['e2']] = data[null]
      data: { moveFrom: 'e2' },
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });
});

// ═══ Short-circuit preventing errors ═══

describe('short-circuit must prevent errors', () => {

  test('&& short-circuits before accessing property on null', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow update: if resource.data.exists == true
          && resource.data.nested.deep.value == 'x';
    }
  }
}`;
    // resource.data.exists is false/missing → first condition false → short-circuit
    // resource.data.nested doesn't exist → accessing .deep would error without short-circuit
    const r = sim(RULES, [{
      description: '&& skips deep access when first is false',
      expectation: 'DENY',
      method: 'update',
      path: 'test/doc1',
      auth: { uid: 'u1' },
      resource: {}, // no 'exists' field, no 'nested' field
      data: {},
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });

  test('|| short-circuits before accessing property on null', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow read: if resource.data.isPublic == true
          || resource.data.acl[request.auth.uid] == true;
    }
  }
}`;
    // isPublic is true → short-circuit, never accesses acl (which doesn't exist)
    const r = sim(RULES, [{
      description: '|| skips acl check when isPublic is true',
      expectation: 'ALLOW',
      method: 'get',
      path: 'test/doc1',
      auth: { uid: 'u1' },
      resource: { isPublic: true }, // no acl field
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });

  test('guard pattern: captured != "" && expensive check', () => {
    // This is the exact pattern from chess — guard prevents accessing
    // config maps that don't have entries for the empty string
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      function cfg() {
        return get(/databases/$(database)/documents/config/data).data;
      }
      allow update: if request.resource.data.captured != ''
          && request.resource.data.captured in cfg().validCaptures;
    }
  }
}`;
    // captured is '' → first condition false → short-circuit, never calls cfg()
    const r = sim(RULES, [{
      description: 'empty string guard prevents get() call',
      expectation: 'DENY',
      method: 'update',
      path: 'test/doc1',
      auth: { uid: 'u1' },
      resource: {},
      data: { captured: '' },
      // No functionMock — get() should never be called due to short-circuit
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });
});

// ═══ get() edge cases ═══

describe('get() edge cases', () => {

  test('get() on non-existent document — accessing .data should return null', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow read: if get(/databases/$(database)/documents/config/missing) != null
          && get(/databases/$(database)/documents/config/missing).data.field == 'x';
    }
  }
}`;
    // get() returns null for missing doc → first check fails → short-circuit
    const r = sim(RULES, [{
      description: 'get() on missing doc with guard',
      expectation: 'DENY',
      method: 'get',
      path: 'test/doc1',
      auth: { uid: 'u1' },
      // No functionMock → doc doesn't exist
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });

  test('get() returns mock, access nested field', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow update: if get(/databases/$(database)/documents/config/data).data.allowed == true;
    }
  }
}`;
    const r = sim(RULES, [{
      description: 'get() with nested access',
      expectation: 'ALLOW',
      method: 'update',
      path: 'test/doc1',
      auth: { uid: 'u1' },
      resource: {},
      data: {},
      functionMocks: [{ function: 'get', path: 'config/data', result: { allowed: true } }],
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });
});

// ═══ in operator edge cases ═══

describe('in operator edge cases', () => {

  test('value in undefined/null map — false, not error', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow update: if 'x' in resource.data.nonExistentMap;
    }
  }
}`;
    const r = sim(RULES, [{
      description: 'in on missing map',
      expectation: 'DENY',
      method: 'update',
      path: 'test/doc1',
      auth: { uid: 'u1' },
      resource: {},
      data: {},
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });

  test('value in empty map — false', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow update: if 'x' in resource.data.emptyMap;
    }
  }
}`;
    const r = sim(RULES, [{
      description: 'in on empty map',
      expectation: 'DENY',
      method: 'update',
      path: 'test/doc1',
      auth: { uid: 'u1' },
      resource: { emptyMap: {} },
      data: {},
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });

  test('in with dynamic key from get() result', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      function cfg() {
        return get(/databases/$(database)/documents/config/data).data;
      }
      allow update: if request.resource.data.target in cfg().allowed;
    }
  }
}`;
    const r = sim(RULES, [
      {
        description: 'target in allowed map — true',
        expectation: 'ALLOW',
        method: 'update',
        path: 'test/doc1',
        auth: { uid: 'u1' },
        resource: {},
        data: { target: 'admin' },
        functionMocks: [{ function: 'get', path: 'config/data', result: { allowed: { admin: true, editor: true } } }],
      },
      {
        description: 'target not in allowed map — false',
        expectation: 'DENY',
        method: 'update',
        path: 'test/doc1',
        auth: { uid: 'u1' },
        resource: {},
        data: { target: 'viewer' },
        functionMocks: [{ function: 'get', path: 'config/data', result: { allowed: { admin: true, editor: true } } }],
      },
    ]);
    expect(r.results[0].state).toBe('PASSED');
    expect(r.results[1].state).toBe('PASSED');
  });
});

// ═══ Multiple match blocks ═══

describe('multiple match blocks', () => {
  const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /public/{docId} {
      allow read: if true;
      allow write: if false;
    }
    match /private/{docId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == resource.data.owner;
    }
    match /admin/{docId} {
      allow read, write: if request.auth != null && request.auth.token.admin == true;
    }
  }
}`;

  test('routes to correct match block', () => {
    const r = sim(RULES, [
      { description: 'public read', expectation: 'ALLOW', method: 'get', path: 'public/doc1' },
      { description: 'public write', expectation: 'DENY', method: 'create', path: 'public/doc1', auth: { uid: 'u1' }, data: {} },
      { description: 'private read authed', expectation: 'ALLOW', method: 'get', path: 'private/doc1', auth: { uid: 'u1' } },
      { description: 'private read unauthed', expectation: 'DENY', method: 'get', path: 'private/doc1', auth: null },
      { description: 'admin with claim', expectation: 'ALLOW', method: 'get', path: 'admin/doc1', auth: { uid: 'u1', token: { admin: true } } },
      { description: 'admin without claim', expectation: 'DENY', method: 'get', path: 'admin/doc1', auth: { uid: 'u1', token: {} } },
      { description: 'nonexistent collection', expectation: 'DENY', method: 'get', path: 'other/doc1', auth: { uid: 'u1' } },
    ]);
    expect(r.failed).toBe(0);
  });
});

// ═══ Comparison of null with values ═══

describe('null comparison semantics', () => {
  const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow update: if resource.data.field != null
          && resource.data.field != '';
    }
  }
}`;

  test('field exists and non-empty — allowed', () => {
    const r = sim(RULES, [{
      description: 'field has value',
      expectation: 'ALLOW',
      method: 'update',
      path: 'test/doc1',
      resource: { field: 'hello' },
      data: {},
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });

  test('field is null — denied at first check', () => {
    const r = sim(RULES, [{
      description: 'field is null',
      expectation: 'DENY',
      method: 'update',
      path: 'test/doc1',
      resource: { field: null },
      data: {},
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });

  test('field missing (undefined → null) — denied', () => {
    const r = sim(RULES, [{
      description: 'field missing',
      expectation: 'DENY',
      method: 'update',
      path: 'test/doc1',
      resource: {}, // no 'field' key
      data: {},
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });

  test('field is empty string — passes null check, fails empty check', () => {
    const r = sim(RULES, [{
      description: 'field is empty string',
      expectation: 'DENY',
      method: 'update',
      path: 'test/doc1',
      resource: { field: '' },
      data: {},
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });
});

// ═══ Function that errors inside a short-circuit chain ═══

describe('function errors inside short-circuit', () => {

  test('function accessing bad data, but guard prevents call', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      function riskyCheck() {
        return resource.data.deep.nested.value == 'x';
      }
      allow update: if resource.data.shouldCheck == true && riskyCheck();
    }
  }
}`;
    // shouldCheck is false → short-circuit, riskyCheck never called
    const r = sim(RULES, [{
      description: 'guard prevents risky function call',
      expectation: 'DENY',
      method: 'update',
      path: 'test/doc1',
      resource: { shouldCheck: false },
      data: {},
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });

  test('function that errors when actually called — rule denies', () => {
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      function riskyCheck() {
        return resource.data.deep.nested.value == 'x';
      }
      allow update: if resource.data.shouldCheck == true && riskyCheck();
    }
  }
}`;
    // shouldCheck is true → riskyCheck called → data.deep is null → error → deny
    const r = sim(RULES, [{
      description: 'risky function called and errors',
      expectation: 'DENY',
      method: 'update',
      path: 'test/doc1',
      resource: { shouldCheck: true }, // no 'deep' field
      data: {},
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });
});

// ═══ String >= / <= comparisons (used in promotion check) ═══

describe('string comparison operators', () => {
  const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow update: if request.resource.data.square >= 'a1'
          && request.resource.data.square <= 'h8';
    }
  }
}`;

  test('a1 is in range', () => {
    const r = sim(RULES, [{
      description: 'a1 in range', expectation: 'ALLOW', method: 'update', path: 'test/d1', data: { square: 'a1' },
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });

  test('h8 is in range', () => {
    const r = sim(RULES, [{
      description: 'h8 in range', expectation: 'ALLOW', method: 'update', path: 'test/d1', data: { square: 'h8' },
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });

  test('z9 is out of range', () => {
    const r = sim(RULES, [{
      description: 'z9 out of range', expectation: 'DENY', method: 'update', path: 'test/d1', data: { square: 'z9' },
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });
});

// ═══ The chess moveType == 'pawn_forward' pattern that failed in v1 ═══

describe('the chess pattern that broke v1', () => {

  // Simplified version of the chess rules with shared gates
  // This is what caused the production failures — does the simulator
  // correctly evaluate both rules when they share a gate?
  const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      function cfg() {
        return get(/databases/$(database)/documents/config/data).data;
      }
      function validPieceMove() {
        let mf = request.resource.data.moveFrom;
        let mt = request.resource.data.moveTo;
        let piece = resource.data[mf];
        return mt in cfg().moves[piece][mf];
      }
      function validPawnForward() {
        let mf = request.resource.data.moveFrom;
        let mt = request.resource.data.moveTo;
        let piece = resource.data[mf];
        return (piece == 'P' || piece == 'p')
            && mt in cfg().pawnForward[piece][mf]
            && resource.data[mt] == '';
      }
      allow update: if request.resource.data.moveType == 'normal'
          && request.auth != null && validPieceMove();
      allow update: if request.resource.data.moveType == 'normal'
          && request.auth != null && validPawnForward();
    }
  }
}`;

  const CONFIG = {
    moves: { N: { b1: { c3: true, a3: true } } },
    pawnForward: { P: { e2: { e3: true } } },
  };

  test('knight move via first rule', () => {
    const r = sim(RULES, [{
      description: 'knight via shared gate',
      expectation: 'ALLOW',
      method: 'update',
      path: 'test/d1',
      auth: { uid: 'u1' },
      resource: { b1: 'N' },
      data: { moveType: 'normal', moveFrom: 'b1', moveTo: 'c3' },
      functionMocks: [{ function: 'get', path: 'config/data', result: CONFIG }],
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });

  test('pawn move via second rule (shared gate)', () => {
    const r = sim(RULES, [{
      description: 'pawn via shared gate',
      expectation: 'ALLOW',
      method: 'update',
      path: 'test/d1',
      auth: { uid: 'u1' },
      resource: { e2: 'P', e3: '' },
      data: { moveType: 'normal', moveFrom: 'e2', moveTo: 'e3' },
      functionMocks: [{ function: 'get', path: 'config/data', result: CONFIG }],
    }]);
    expect(r.results[0].state).toBe('PASSED');
  });

  test('pawn via shared gate — first rule errors (no P in moves), second rule catches it', () => {
    // This is the KEY test. In production, the first rule (validPieceMove)
    // errors because moves doesn't have a 'P' entry. The error propagates
    // as a deny for that rule. Then the second rule (validPawnForward) matches.
    // The simulator must handle the error in the first rule gracefully
    // and try the second rule.
    const r = sim(RULES, [{
      description: 'first rule errors, second catches',
      expectation: 'ALLOW',
      method: 'update',
      path: 'test/d1',
      auth: { uid: 'u1' },
      resource: { e2: 'P', e3: '' },
      data: { moveType: 'normal', moveFrom: 'e2', moveTo: 'e3' },
      functionMocks: [{ function: 'get', path: 'config/data', result: CONFIG }],
    }]);
    if (r.results[0].state === 'FAILED') {
      console.log('Shared gate debug:', r.results[0].debugMessages);
    }
    expect(r.results[0].state).toBe('PASSED');
  });
});
