/**
 * getAfter() / existsAfter() — Item 7 of REBUILD_PLAN.md.
 *
 * Both builtins return the projected post-write state for the document
 * being written. For unrelated paths they fall through to get/exists.
 *
 * Covers backwards-compat default (no writeMode → tc.data IS after-state)
 * AND the new explicit writeMode path that uses projectAfterState.
 */
import { describe, test, expect } from 'bun:test';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import type { TestCase } from 'pyric/rules/internal';

const sim = new SimulateFirestoreRulesHandler();

function rules(condition: string, matchPath = 'docs/{id}'): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /${matchPath} {
      allow create, update, delete: if ${condition};
    }
  }
}`;
}

describe('getAfter — request target with no writeMode (legacy)', () => {
  test('getAfter(request.path).data == request.resource.data for create', () => {
    const r = sim.simulate(
      rules("getAfter(request.path).data.x == request.resource.data.x"),
      [{
        description: 'getAfter for create',
        expectation: 'ALLOW',
        method: 'create',
        path: 'docs/d1',
        auth: { uid: 'u1' },
        data: { x: 'value' },
      }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('getAfter(request.path).data.field returns the written value', () => {
    const r = sim.simulate(
      rules("getAfter(request.path).data.x == 42"),
      [{
        description: 'after-state value',
        expectation: 'ALLOW',
        method: 'create',
        path: 'docs/d1',
        auth: { uid: 'u1' },
        data: { x: 42 },
      }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});

describe('getAfter — request target with explicit writeMode update', () => {
  test('top-level update REPLACES nested map (0.D trap)', () => {
    // Explicit writeMode triggers projectAfterState. Pre-state has email,
    // payload only sets name. Top-level update REPLACES profile entirely
    // → email is gone. Rule expects after-state has no email field.
    const r = sim.simulate(
      rules("getAfter(request.path).data.profile.name == 'new' && !('email' in getAfter(request.path).data.profile)"),
      [{
        description: 'update replaces top-level map',
        expectation: 'ALLOW',
        method: 'update',
        path: 'docs/d1',
        auth: { uid: 'u1' },
        resource: { profile: { name: 'old', email: 'e@x' } },
        data: { profile: { name: 'new' } },
        writeMode: { kind: 'update' },
      }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('dot-path update patches nested map (preserves siblings)', () => {
    const r = sim.simulate(
      rules("getAfter(request.path).data.profile.name == 'new' && getAfter(request.path).data.profile.email == 'e@x'"),
      [{
        description: 'dot-path update',
        expectation: 'ALLOW',
        method: 'update',
        path: 'docs/d1',
        auth: { uid: 'u1' },
        resource: { profile: { name: 'old', email: 'e@x' } },
        data: { 'profile.name': 'new' },
        writeMode: { kind: 'update' },
      }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('set merge:true recursively merges nested maps', () => {
    const r = sim.simulate(
      rules("getAfter(request.path).data.profile.name == 'new' && getAfter(request.path).data.profile.email == 'e@x'"),
      [{
        description: 'set merge true preserves email',
        expectation: 'ALLOW',
        method: 'update',
        path: 'docs/d1',
        auth: { uid: 'u1' },
        resource: { profile: { name: 'old', email: 'e@x' } },
        data: { profile: { name: 'new' } },
        writeMode: { kind: 'set', merge: true },
      }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('set merge:false replaces document wholesale', () => {
    const r = sim.simulate(
      rules("getAfter(request.path).data.x == 1 && !('y' in getAfter(request.path).data)"),
      [{
        description: 'set merge false replaces',
        expectation: 'ALLOW',
        method: 'update',
        path: 'docs/d1',
        auth: { uid: 'u1' },
        resource: { x: 'old', y: 'gone' },
        data: { x: 1 },
        writeMode: { kind: 'set', merge: false },
      }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});

describe('existsAfter — request target', () => {
  test('existsAfter(request.path) is true for create', () => {
    const r = sim.simulate(
      rules("existsAfter(request.path) == true"),
      [{
        description: 'existsAfter create',
        expectation: 'ALLOW',
        method: 'create',
        path: 'docs/d1',
        auth: { uid: 'u1' },
        data: { x: 1 },
      }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('existsAfter(request.path) is false for delete', () => {
    const r = sim.simulate(
      rules("existsAfter(request.path) == false"),
      [{
        description: 'existsAfter delete',
        expectation: 'ALLOW',
        method: 'delete',
        path: 'docs/d1',
        auth: { uid: 'u1' },
        resource: { x: 'gone' },
      }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('existsAfter(request.path) is false with writeMode delete', () => {
    const r = sim.simulate(
      rules("!existsAfter(request.path)"),
      [{
        description: 'explicit delete writeMode',
        expectation: 'ALLOW',
        method: 'delete',
        path: 'docs/d1',
        auth: { uid: 'u1' },
        resource: { x: 'gone' },
        writeMode: { kind: 'delete' },
      }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});

describe('getAfter / existsAfter — unrelated paths fall through', () => {
  test('getAfter(other path) uses get() mock', () => {
    const r = sim.simulate(
      rules("getAfter(/databases/$(database)/documents/other/x).data.k == 'v'"),
      [{
        description: 'getAfter unrelated path uses mock',
        expectation: 'ALLOW',
        method: 'create',
        path: 'docs/d1',
        auth: { uid: 'u1' },
        data: {},
        functionMocks: [
          { function: 'get', path: 'other/x', result: { k: 'v' } },
        ],
      }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('existsAfter(other path) uses exists() mock', () => {
    const r = sim.simulate(
      rules("existsAfter(/databases/$(database)/documents/other/x) == true"),
      [{
        description: 'existsAfter unrelated path uses mock',
        expectation: 'ALLOW',
        method: 'create',
        path: 'docs/d1',
        auth: { uid: 'u1' },
        data: {},
        functionMocks: [
          { function: 'exists', path: 'other/x', result: true },
        ],
      }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('existsAfter(missing path) returns false', () => {
    const r = sim.simulate(
      rules("existsAfter(/databases/$(database)/documents/missing/y) == false"),
      [{
        description: 'existsAfter missing path is false',
        expectation: 'ALLOW',
        method: 'create',
        path: 'docs/d1',
        auth: { uid: 'u1' },
        data: {},
      }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});

describe('getAfter / existsAfter — DENY witnesses', () => {
  test('getAfter wrong field value DENY', () => {
    const r = sim.simulate(
      rules("getAfter(request.path).data.x == 'other'"),
      [{
        description: 'wrong getAfter value',
        expectation: 'DENY',
        method: 'create',
        path: 'docs/d1',
        auth: { uid: 'u1' },
        data: { x: 'actual' },
      }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('existsAfter wrong existence DENY', () => {
    const r = sim.simulate(
      rules("existsAfter(request.path) == false"),
      [{
        description: 'create has existsAfter true, rule expects false',
        expectation: 'DENY',
        method: 'create',
        path: 'docs/d1',
        auth: { uid: 'u1' },
        data: {},
      }],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});
