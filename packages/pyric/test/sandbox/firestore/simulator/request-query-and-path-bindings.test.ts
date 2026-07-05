/**
 * Two related silent-DENY surfaces, both follow-ups to REBUILD_PLAN.md
 * Item 6:
 *
 *   1. request.query.{limit,offset,orderBy} for `list` operations
 *   2. request.path.<wildcardName> for matched-rule bindings
 *
 * Before this change, both returned undefined/null for valid Firestore rule
 * expressions. The evaluator treats null as falsy → DENY, which is exactly
 * the silent-DENY shape Item 0.A's UnsupportedError category was built to
 * prevent. Tests below exercise the populated shape (rule reads succeed)
 * and the empty shape (rule reads return null but no longer throw).
 */
import { describe, test, expect } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules';
import { Path } from 'pyric/rules';
import type { TestCase } from 'pyric/rules';

const sim = new SimulateFirestoreRulesHandler();

function rules(condition: string, op: 'list' | 'get' | 'create' = 'list'): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow ${op}: if ${condition};
    }
  }
}`;
}

const baseList = (overrides: Partial<TestCase> = {}): TestCase => ({
  description: 'list docs',
  expectation: 'ALLOW',
  method: 'list',
  path: 'docs/d1',
  auth: { uid: 'u1' },
  ...overrides,
});

// ─── (1) request.query coverage ───────────────────────────────────────────

describe('request.query — list ops with populated query', () => {
  test('limit can be read', () => {
    const r = sim.simulate(
      rules('request.query.limit < 100'),
      [baseList({ query: { limit: 50 } })],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('limit at boundary denies as expected', () => {
    const r = sim.simulate(
      rules('request.query.limit < 100'),
      [baseList({ query: { limit: 100 }, expectation: 'DENY' })],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('offset can be read', () => {
    const r = sim.simulate(
      rules('request.query.offset == 10'),
      [baseList({ query: { offset: 10 } })],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('orderBy can be read', () => {
    const r = sim.simulate(
      rules("request.query.orderBy == 'createdAt'"),
      [baseList({ query: { orderBy: 'createdAt' } })],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('multiple query fields evaluated together', () => {
    const r = sim.simulate(
      rules("request.query.limit <= 25 && request.query.orderBy == 'name'"),
      [baseList({ query: { limit: 25, orderBy: 'name' } })],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});

describe('request.query — list ops without query payload', () => {
  test('field reads return null (rule denies on equality with non-null)', () => {
    // No tc.query → request.query.limit is null → equality with a number
    // is false → DENY. This is the documented behavior, not a silent type
    // error. (Note: `null < N` evaluates to true via JS numeric coercion,
    // so we use `==` here for an unambiguous false.)
    const r = sim.simulate(
      rules('request.query.limit == 50'),
      [baseList({ expectation: 'DENY' })],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('checking for missing field via == null allows', () => {
    const r = sim.simulate(
      rules('request.query.limit == null'),
      [baseList()],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});

describe('request.query — non-list ops always empty', () => {
  test('get op: tc.query is ignored, request.query is empty', () => {
    // Even if a test mistakenly passes query for a get op, the simulator
    // treats it as empty (matches production: query only flows on list).
    const tcGet: TestCase = {
      description: 'get with stray query',
      expectation: 'DENY',
      method: 'get',
      path: 'docs/d1',
      auth: { uid: 'u1' },
      query: { limit: 5 },
    };
    const r = sim.simulate(
      rules('request.query.limit == 5', 'get'),
      [tcGet],
    );
    // request.query is empty for non-list ops → request.query.limit is
    // null → null == 5 is false → DENY (matches expectation).
    expect(r.success && r.data.passed).toBe(1);
  });
});

// ─── (2) Path named-field bindings ───────────────────────────────────────

describe('Path.field — named bindings (wrapper-level)', () => {
  test('bound path exposes name via field()', () => {
    const p = Path.fromString('/users/{uid}/posts/{pid}').bind({
      uid: 'alice',
      pid: 'p1',
    });
    expect(p.field('uid')).toBe('alice');
    expect(p.field('pid')).toBe('p1');
  });

  test('partial bind only exposes the bound names', () => {
    const p = Path.fromString('/users/{uid}/posts/{pid}').bind({ uid: 'alice' });
    expect(p.field('uid')).toBe('alice');
    expect(p.field('pid')).toBe(null);
  });

  test('explicit constructor bindings are exposed', () => {
    const p = new Path(['users', 'alice'], { uid: 'alice' });
    expect(p.field('uid')).toBe('alice');
  });

  test('unbound name → null (no throw)', () => {
    const p = new Path(['users', 'alice']);
    expect(p.field('missing')).toBe(null);
  });

  test('numeric access still works alongside named bindings', () => {
    const p = new Path(['users', 'alice'], { uid: 'alice' });
    expect(p.field('0')).toBe('users');
    expect(p.field('1')).toBe('alice');
  });

  test('bindings do not affect equality', () => {
    // Two paths with identical segments but different bindings are still
    // value-equal — matches Firestore semantics where Path equality is
    // segment-by-segment string compare only.
    const a = new Path(['users', 'alice'], { uid: 'alice' });
    const b = new Path(['users', 'alice']);
    expect(a.equals(b)).toBe(true);
    expect(b.equals(a)).toBe(true);
  });
});

describe('request.path — match-block wildcards exposed by name', () => {
  test('rule reading request.path.id sees the matched wildcard value', () => {
    const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow get: if request.path.id == 'd1';
    }
  }
}`;
    const r = sim.simulate(src, [{
      description: 'request.path.id matches wildcard',
      expectation: 'ALLOW',
      method: 'get',
      path: 'docs/d1',
      auth: { uid: 'u1' },
    }]);
    expect(r.success && r.data.passed).toBe(1);
  });

  test('rule reading nested wildcards (uid + postId)', () => {
    const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/posts/{postId} {
      allow get: if request.path.uid == 'alice' && request.path.postId == 'p1';
    }
  }
}`;
    const r = sim.simulate(src, [{
      description: 'request.path.{uid,postId}',
      expectation: 'ALLOW',
      method: 'get',
      path: 'users/alice/posts/p1',
      auth: { uid: 'alice' },
    }]);
    expect(r.success && r.data.passed).toBe(1);
  });

  test('reading an unbound name on request.path → null (rule denies)', () => {
    const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow get: if request.path.nonexistent == 'x';
    }
  }
}`;
    const r = sim.simulate(src, [{
      description: 'unbound name on request.path',
      expectation: 'DENY',
      method: 'get',
      path: 'docs/d1',
      auth: { uid: 'u1' },
    }]);
    expect(r.success && r.data.passed).toBe(1);
  });
});

describe('Path.bind — bound names are exposed through field() in rules', () => {
  test("path('users/{uid}').bind({uid: 'alice'}).uid == 'alice'", () => {
    const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow get: if path('users/{uid}').bind({'uid': 'alice'}).uid == 'alice';
    }
  }
}`;
    const r = sim.simulate(src, [{
      description: 'bound path field via rules',
      expectation: 'ALLOW',
      method: 'get',
      path: 'docs/d1',
      auth: { uid: 'u1' },
    }]);
    expect(r.success && r.data.passed).toBe(1);
  });
});
