/**
 * Globals — Item 6 of REBUILD_PLAN.md.
 *
 * Per Globals table:
 *   request.path     → Path     full /databases/(default)/documents/<rel>
 *   request.query    → Map      empty for non-list methods
 *
 * resource.id / resource.__name__ are NOT in that table: production does not
 * populate them. It builds `resource` from the stored document alone and
 * derives no identity from the request path, so reading either is an error
 * that absorbs to DENY (RULES-B12; corpus scenario `resource-document-identity`).
 * The simulator used to synthesize both from tc.path, which ALLOWed rules that
 * production DENIES — the describes below now pin production's verdict.
 */
import { describe, test, expect } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import type { TestCase } from 'pyric/rules/internal';

const sim = new SimulateFirestoreRulesHandler();

function rules(condition: string, matchPath = 'docs/{id}', op = 'create'): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /${matchPath} {
      allow ${op}: if ${condition};
    }
  }
}`;
}

function tc(condition: string, expectation: 'ALLOW' | 'DENY', path = 'docs/d1'): TestCase {
  return {
    description: condition,
    expectation,
    method: 'create',
    path,
    auth: { uid: 'u1' },
    data: {},
  };
}

// resource is null on `create` (the document doesn't exist yet pre-write —
// see rules-sim-resource-on-create). Tests that assert resource.id /
// resource.__name__ resolve to the existing document's identity exercise
// `update` instead, with `resource` set to the existing document data —
// this is the mechanism other simulator tests use to populate `resource`
// (see adversarial.test.ts).
function tcExisting(condition: string, expectation: 'ALLOW' | 'DENY', path = 'docs/d1'): TestCase {
  return {
    description: condition,
    expectation,
    method: 'update',
    path,
    auth: { uid: 'u1' },
    resource: {},
    data: {},
  };
}

describe('request.path — Item 6', () => {
  test('request.path is path', () => {
    const r = sim.simulate(
      rules('request.path is path'),
      [tc('request.path typed as path', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('request.path equals the literal /databases/.../documents/...', () => {
    const r = sim.simulate(
      rules("request.path == /databases/$(database)/documents/docs/d1"),
      [tc('request.path equality', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('request.path inequality with different path', () => {
    const r = sim.simulate(
      rules("request.path != /databases/$(database)/documents/docs/somethingelse"),
      [tc('request.path inequality', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});

describe('request.query — Item 6', () => {
  test('request.query is map (empty for non-list ops)', () => {
    const r = sim.simulate(
      rules('request.query is map'),
      [tc('request.query typed as map', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('request.query.size() == 0 for create', () => {
    const r = sim.simulate(
      rules('request.query.size() == 0'),
      [tc('request.query empty for create', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});

// ═══ resource identity is ABSENT, even on an existing document (RULES-B12) ═══
//
// Production truth, captured by the `resource-document-identity` corpus scenario
// and replayed by the rules oracle-conformance suite: production builds
// `resource` from the stored document ALONE and derives NO identity from the
// request path. `resource.id` / `resource.__name__` are therefore absent
// properties, and reading one is a runtime ERROR:
//   "Property id is undefined on object." / "Property __name__ is undefined on object."
// which absorbs to DENY. These tests previously asserted ALLOW — the simulator
// synthesized an id/__name__ from tc.path, so `resource.id == id` ALLOWed where
// production DENIES. That was an OVER-PERMISSIVE divergence (the dangerous
// direction of wrong) and is what this describe block now pins against.
//
// The id a rule can legitimately read is the match-path wildcard (`docs/{id}`).
describe('resource.id — absent in production (RULES-B12)', () => {
  test("resource.id on an existing doc DENIES (identity is absent, the read errors)", () => {
    const r = sim.simulate(
      rules("resource.id == 'd1'", 'docs/{id}', 'update'),
      [tcExisting('resource.id read', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("resource.id is string DENIES (the property read errors before the type test)", () => {
    const r = sim.simulate(
      rules("resource.id is string", 'docs/{id}', 'update'),
      [tcExisting('resource.id typed', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("resource.id on a nested existing doc DENIES", () => {
    const r = sim.simulate(
      rules("resource.id == 'p99'", 'users/{uid}/posts/{pid}', 'update'),
      [{ ...tcExisting('nested resource.id', 'DENY'), path: 'users/alice/posts/p99' }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  // The load-bearing case: the absent read is a PROPAGATING ERROR, not a false.
  // Modeling it as a plain `undefined` would make this comparison true and
  // FALSE-ALLOW, which is precisely the failure mode this class of bug takes.
  test("resource.id != 'zzz' DENIES — the error survives negation", () => {
    const r = sim.simulate(
      rules("resource.id != 'zzz'", 'docs/{id}', 'update'),
      [tcExisting('resource.id negated', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("resource.id == 'zzz' || true ALLOWS — a determining || operand absorbs the error", () => {
    const r = sim.simulate(
      rules("resource.id == 'zzz' || true", 'docs/{id}', 'update'),
      [tcExisting('resource.id absorbed', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("resource.id on a create DENIES (resource is null pre-write)", () => {
    const r = sim.simulate(
      rules("resource.id == 'wrongId'"),
      [tc('resource.id on create', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});

describe('resource.__name__ — absent in production (RULES-B12)', () => {
  test("resource.__name__ is path DENIES (identity is absent, the read errors)", () => {
    const r = sim.simulate(
      rules("resource.__name__ is path", 'docs/{id}', 'update'),
      [tcExisting('__name__ typed as path', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("resource.__name__ == request.path DENIES", () => {
    const r = sim.simulate(
      rules("resource.__name__ == request.path", 'docs/{id}', 'update'),
      [tcExisting('__name__ matches request.path', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("resource.__name__ == literal DENIES", () => {
    const r = sim.simulate(
      rules("resource.__name__ == /databases/$(database)/documents/docs/d1", 'docs/{id}', 'update'),
      [tcExisting('__name__ matches literal', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});

describe('Globals — composability', () => {
  test('resource.id compared to the path variable DENIES (identity absent)', () => {
    const r = sim.simulate(
      rules("resource.id == id", 'docs/{id}', 'update'),
      [tcExisting('resource.id == id binding', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('a resource.id conjunct DENIES the whole rule, even with request.path/query true', () => {
    // && cannot absorb the error — no operand is false, so it propagates.
    const r = sim.simulate(
      rules("request.path is path && resource.id == 'd1' && request.query is map", 'docs/{id}', 'update'),
      [tcExisting('all three globals', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('request.path and request.query still compose without resource identity', () => {
    const r = sim.simulate(
      rules("request.path is path && request.query is map", 'docs/{id}', 'update'),
      [tcExisting('path + query', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});
