/**
 * Set.difference / Set.union / Set.intersection — abstain, don't guess.
 *
 * Oracle capture (set-algebra-difference-union-intersection and
 * list-methods-concat-removeall-toset corpus scenarios) showed the simulator
 * computing a plausible-looking result for these three methods while
 * production DENIES every request that reaches them (false-ALLOW: the
 * most dangerous divergence for a rules-assurance tool). The methods
 * don't behave as modeled in the real Firestore Rules CEL dialect.
 *
 * Rather than reverse-engineer the true semantics blind, the simulator
 * now abstains (UNSUPPORTED) whenever `.difference()`, `.union()`, or
 * `.intersection()` is called on a FirestoreSet, mirroring the existing
 * abstention path used elsewhere for unimplemented features (see
 * unsupported-feature-witness corpus scenario / UnsupportedError in
 * evaluator.ts). hasOnly/hasAll/hasAny/size/equals on FirestoreSet, and
 * List.concat/removeAll/toSet, are unaffected — those are prod-verified
 * and must keep working.
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../src/rules/test/spec.js';

const handler = new SimulateFirestoreRulesHandler();

function run(rules: string, tc: TestCase) {
  const res = handler.simulate(rules, [tc]);
  if (!res.success || !res.data) throw new Error('simulate failed');
  return res.data.results[0]!;
}

describe('Set.difference/union/intersection abstain (UNSUPPORTED), not a guessed verdict', () => {
  test('difference() with a list arg abstains', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /diffListAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().difference(['a','b']).hasOnly(['c']);
    }
  }
}`;
    const result = run(rules, {
      description: 'set difference (list arg)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'diffListAllow/d1',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2, c: 3 } },
    } as TestCase);
    expect(result.state).toBe('UNSUPPORTED');
  });

  test('difference() with a Set arg (via .keys()) abstains', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /diffSetAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.keys().difference(request.resource.data.b.keys()).hasOnly(['x']);
    }
  }
}`;
    const result = run(rules, {
      description: 'set difference (set arg)',
      expectation: 'ALLOW',
      method: 'create',
      path: 'diffSetAllow/d2',
      auth: { uid: 'alice' },
      data: { a: { x: 1, y: 2 }, b: { y: 2, z: 3 } },
    } as TestCase);
    expect(result.state).toBe('UNSUPPORTED');
  });

  test('union() abstains', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /unionAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().union(['c','d']).size() == 4;
    }
  }
}`;
    const result = run(rules, {
      description: 'set union',
      expectation: 'ALLOW',
      method: 'create',
      path: 'unionAllow/d3',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    } as TestCase);
    expect(result.state).toBe('UNSUPPORTED');
  });

  test('intersection() abstains', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /interAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().intersection(['b','c','d']).hasOnly(['b','c']);
    }
  }
}`;
    const result = run(rules, {
      description: 'set intersection',
      expectation: 'ALLOW',
      method: 'create',
      path: 'interAllow/d5',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2, c: 3 } },
    } as TestCase);
    expect(result.state).toBe('UNSUPPORTED');
  });

  test('chained union().difference() abstains (fails on the first unsupported call it hits)', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /chainAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().union(['c']).difference(['a']).hasOnly(['b','c']);
    }
  }
}`;
    const result = run(rules, {
      description: 'chained union+difference',
      expectation: 'ALLOW',
      method: 'create',
      path: 'chainAllow/d7',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    } as TestCase);
    expect(result.state).toBe('UNSUPPORTED');
  });

  test('List.toSet().difference() abstains (list-methods scenario 5.1/5.2 wiring case)', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /toSetChainAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.toSet().difference(['a']).hasOnly(['b','c']);
    }
  }
}`;
    const result = run(rules, {
      description: 'toSet().difference() chain',
      expectation: 'ALLOW',
      method: 'create',
      path: 'toSetChainAllow/d1',
      auth: { uid: 'alice' },
      data: { a: ['a', 'b', 'c'] },
    } as TestCase);
    expect(result.state).toBe('UNSUPPORTED');
  });

  test('DENY witness with difference() also abstains, not a coincidental DENY match', () => {
    // Before the fix this happened to match expectation=DENY because the
    // sim's computed size (1) != 99 — a right answer for the wrong reason.
    // Abstaining here is still correct: the sim cannot faithfully evaluate
    // Set.difference(), regardless of which verdict the corpus expects.
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /diffDeny/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().difference(['a']).size() == 99;
    }
  }
}`;
    const result = run(rules, {
      description: 'difference with wrong expected size',
      expectation: 'DENY',
      method: 'create',
      path: 'diffDeny/d8',
      auth: { uid: 'alice' },
      data: { m: { a: 1, b: 2 } },
    } as TestCase);
    expect(result.state).toBe('UNSUPPORTED');
  });
});

describe('Set/List operations NOT affected by the abstain gate (must keep working)', () => {
  function ok(rules: string, tc: TestCase) {
    const result = run(rules, tc);
    expect(result.state).toBe('PASSED');
  }

  test('FirestoreSet.hasOnly/hasAll/hasAny/size still evaluate (no over-abstain)', () => {
    ok(
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /hasOnlyAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.m.keys().hasOnly(['a','b','c']);
    }
  }
}`,
      {
        description: 'hasOnly still works',
        expectation: 'ALLOW',
        method: 'create',
        path: 'hasOnlyAllow/d1',
        auth: { uid: 'alice' },
        data: { m: { a: 1, b: 2 } },
      } as TestCase,
    );
  });

  test('List.concat still evaluates (no over-abstain)', () => {
    ok(
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /concatAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.concat(request.resource.data.b).size() == 4;
    }
  }
}`,
      {
        description: 'concat still works',
        expectation: 'ALLOW',
        method: 'create',
        path: 'concatAllow/d1',
        auth: { uid: 'alice' },
        data: { a: ['a', 'b'], b: ['c', 'd'] },
      } as TestCase,
    );
  });

  test('List.removeAll still evaluates (no over-abstain)', () => {
    ok(
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /removeAllAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.removeAll(['b']).size() == 2;
    }
  }
}`,
      {
        description: 'removeAll still works',
        expectation: 'ALLOW',
        method: 'create',
        path: 'removeAllAllow/d1',
        auth: { uid: 'alice' },
        data: { a: ['a', 'b', 'c'] },
      } as TestCase,
    );
  });

  test('List.toSet() alone (no difference/union/intersection chain) still evaluates', () => {
    ok(
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /toSetAllow/{id} {
      allow create: if request.auth != null
        && request.resource.data.a.toSet().size() == 3;
    }
  }
}`,
      {
        description: 'toSet still works',
        expectation: 'ALLOW',
        method: 'create',
        path: 'toSetAllow/d1',
        auth: { uid: 'alice' },
        data: { a: ['a', 'b', 'c'] },
      } as TestCase,
    );
  });
});
