/**
 * Globals — Item 6 of REBUILD_PLAN.md.
 *
 * Per Globals table:
 *   request.path     → Path     full /databases/(default)/documents/<rel>
 *   request.query    → Map      empty for non-list methods
 *   resource.id      → String   last segment of the relative path
 *   resource.__name__ → Path    same as request.path
 *
 * Pre-fix: every one of these was undefined / unpopulated, so any rule
 * that referenced them silently denied. Whole class of buggy ALLOWs
 * surfaces as PASS only after this lands.
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

describe('resource.id — Item 6', () => {
  test("resource.id == 'd1' for path docs/d1", () => {
    const r = sim.simulate(
      rules("resource.id == 'd1'", 'docs/{id}', 'update'),
      [tcExisting('resource.id matches', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("resource.id is string", () => {
    const r = sim.simulate(
      rules("resource.id is string", 'docs/{id}', 'update'),
      [tcExisting('resource.id typed', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("resource.id matches nested path's last segment", () => {
    const r = sim.simulate(
      rules("resource.id == 'p99'", 'users/{uid}/posts/{pid}', 'update'),
      [{ ...tcExisting("nested resource.id", 'ALLOW'), path: 'users/alice/posts/p99' }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("resource.id wrong value DENY", () => {
    const r = sim.simulate(
      rules("resource.id == 'wrongId'"),
      [tc('resource.id mismatch', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});

describe('resource.__name__ — Item 6', () => {
  test("resource.__name__ is path", () => {
    const r = sim.simulate(
      rules("resource.__name__ is path", 'docs/{id}', 'update'),
      [tcExisting('__name__ typed as path', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("resource.__name__ equals request.path", () => {
    const r = sim.simulate(
      rules("resource.__name__ == request.path", 'docs/{id}', 'update'),
      [tcExisting('__name__ matches request.path', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("resource.__name__ equals the literal", () => {
    const r = sim.simulate(
      rules("resource.__name__ == /databases/$(database)/documents/docs/d1", 'docs/{id}', 'update'),
      [tcExisting('__name__ matches literal', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});

describe('Globals — composability', () => {
  test('resource.id used in path-variable comparison', () => {
    // Combines path-variable binding with resource.id (both should be 'd1')
    const r = sim.simulate(
      rules("resource.id == id", 'docs/{id}', 'update'),
      [tcExisting('resource.id == id binding', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('rule using both request.path and resource.id together', () => {
    const r = sim.simulate(
      rules("request.path is path && resource.id == 'd1' && request.query is map", 'docs/{id}', 'update'),
      [tcExisting('all three globals', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});
