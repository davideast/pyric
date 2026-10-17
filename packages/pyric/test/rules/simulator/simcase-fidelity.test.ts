/**
 * Simulate-case fidelity (#1058 PR 3): the `TestCase` projection that
 * `simulate()` / `explain()` evaluate must agree with the in-page sandbox,
 * which is what a real Firestore commit looks like to the rules.
 *
 * Evidence per block is cited at the block. Every assertion here is on a
 * rules verdict, so each one flips when the projection is wrong.
 */
import { describe, test, expect } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../src/rules/test/spec.js';
import {
  bytes,
  latlng,
  reference,
  serverTimestamp,
  timestamp,
} from '../../../src/rules/api/values.js';

const handler = new SimulateFirestoreRulesHandler();

function decide(rules: string, tc: Omit<TestCase, 'description' | 'expectation'>): string {
  const r = handler.simulate(rules, [{ description: 'case', expectation: 'ALLOW', ...tc } as TestCase]);
  if (!r.success) throw new Error(`simulate failed: ${r.error.message}`);
  return r.data.results[0]!.decision;
}

function itemsRules(condition: string, ops = 'create, update'): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow ${ops}: if ${condition};
    }
  }
}`;
}

// FS-CON-1 / FS-MET-4a. Firestore value types (timestamp, bytes, latlng,
// reference) are scalar values, not maps: `set(..., {merge: true})` replaces
// such a field as a leaf. The in-page sandbox (`field-merge.ts`) treats them
// as leaves, and the hunt's differential repro (fs-verify-b/FS-MET-4.mjs)
// shows the sandbox ALLOW where simulate() DENIED.
describe('set merge keeps value wrappers as leaves', () => {
  test('merged timestamp/bytes/latlng/reference stay typed', () => {
    const rules = itemsRules(
      'request.resource.data.at is timestamp'
        + ' && request.resource.data.at == timestamp.date(2026, 1, 1)'
        + ' && request.resource.data.payload is bytes'
        + ' && request.resource.data.loc is latlng'
        // The reference's rules type name is not under test here; only that
        // the merge kept it a scalar rather than spreading it into a map.
        + ' && !(request.resource.data.ref is map)',
    );
    expect(decide(rules, {
      method: 'update',
      path: 'items/i1',
      resource: {
        at: timestamp('2025-01-01T00:00:00Z'),
        payload: bytes('old'),
        loc: latlng(10, 20),
        ref: reference('users/bob'),
      },
      data: {
        at: timestamp('2026-01-01T00:00:00Z'),
        payload: bytes('new'),
        loc: latlng(37, -122),
        ref: reference('users/alice'),
      },
      writeMode: { kind: 'set', merge: true },
    })).toBe('ALLOW');
  });

  test('a merged timestamp is not a map (no fail-open on map checks)', () => {
    const rules = itemsRules('request.resource.data.at is map');
    expect(decide(rules, {
      method: 'update',
      path: 'items/i1',
      resource: { at: timestamp('2025-01-01T00:00:00Z') },
      data: { at: timestamp('2026-01-01T00:00:00Z') },
      writeMode: { kind: 'set', merge: true },
    })).toBe('DENY');
  });

  test('a map payload over a wrapper replaces it with the map', () => {
    const rules = itemsRules('request.resource.data.at.keys().hasOnly(["x"])');
    expect(decide(rules, {
      method: 'update',
      path: 'items/i1',
      resource: { at: timestamp('2025-01-01T00:00:00Z') },
      data: { at: { x: 1 } },
      writeMode: { kind: 'set', merge: true },
    })).toBe('ALLOW');
  });
});

// FS-CON-1 / FS-MET-4a (dotted update). `updateDoc(ref, {'a.b': 1})` on a
// non-map `a` replaces `a` with `{b: 1}` (project-after-state.ts setNested's
// own documented contract); a wrapper or float is a non-map.
describe('dotted update through a non-map wrapper replaces it', () => {
  test('float prefix', () => {
    const rules = itemsRules(
      'request.resource.data.score is map'
        + ' && request.resource.data.score.keys().hasOnly(["nested"])'
        + ' && request.resource.data.score.nested == 1',
    );
    expect(decide(rules, {
      method: 'update',
      path: 'items/i1',
      resource: { score: 1.5 },
      data: { 'score.nested': 1 },
      writeMode: { kind: 'update' },
    })).toBe('ALLOW');
  });

  test('timestamp prefix', () => {
    const rules = itemsRules('request.resource.data.at.keys().hasOnly(["nested"])');
    expect(decide(rules, {
      method: 'update',
      path: 'items/i1',
      resource: { at: timestamp('2025-01-01T00:00:00Z') },
      data: { 'at.nested': 1 },
      writeMode: { kind: 'update' },
    })).toBe('ALLOW');
  });
});

// FS-CON-1 / FS-MET-4b. The sandbox resolves `serverTimestamp()` inside
// arrays (`value-resolver.ts`), and the differential repro shows the sandbox
// ALLOW where simulate() DENIED.
describe('serverTimestamp() resolves inside arrays', () => {
  test('array element and map inside array', () => {
    const rules = itemsRules(
      'request.resource.data.ts[0] == request.time'
        + ' && request.resource.data.events[0].at == request.time',
      'create',
    );
    expect(decide(rules, {
      method: 'create',
      path: 'items/i1',
      requestTime: '2026-01-01T00:00:00Z',
      data: { ts: [serverTimestamp()], events: [{ at: serverTimestamp() }] },
    })).toBe('ALLOW');
  });
});

// FS-CON-6 / FS-COV-6a / FS-MET-6b. In the Rules Test API `get` and `exists`
// are separate service functions, each with its own FunctionMock
// (`spec.ts:buildFunctionMock` sends `{value: bool}` for exists and
// `{value: {data}}` for get), and mock args are normalized document names
// (`normalizeDocPath`). Production verdicts are pinned by the corpus scenario
// `simcase-mock-and-path-fidelity`.
describe('functionMocks: get and exists are separate, order-free, normalized', () => {
  const docRule = (condition: string) => itemsRules(condition, 'get');

  test('an exists mock does not fabricate a get() document', () => {
    expect(decide(docRule('get(/databases/$(database)/documents/other/x).data.size() == 0'), {
      method: 'get',
      path: 'items/1',
      functionMocks: [{ function: 'exists', path: 'other/x', result: true }],
    })).toBe('DENY');
  });

  test('exists: false is honored next to a get mock', () => {
    expect(decide(docRule('!exists(/databases/$(database)/documents/users/alice)'), {
      method: 'get',
      path: 'items/1',
      functionMocks: [
        { function: 'get', path: 'users/alice', result: { role: 'admin' } },
        { function: 'exists', path: 'users/alice', result: false },
      ],
    })).toBe('ALLOW');
  });

  test('mock order does not change the verdict', () => {
    const rules = docRule(
      'exists(/databases/$(database)/documents/users/alice)'
        + " && get(/databases/$(database)/documents/users/alice).data.role == 'admin'",
    );
    const getMock = { function: 'get' as const, path: 'users/alice', result: { role: 'admin' } };
    const existsMock = { function: 'exists' as const, path: 'users/alice', result: true };
    expect(decide(rules, { method: 'get', path: 'items/1', functionMocks: [existsMock, getMock] })).toBe('ALLOW');
    expect(decide(rules, { method: 'get', path: 'items/1', functionMocks: [getMock, existsMock] })).toBe('ALLOW');
  });

  test('a leading-slash or full-name mock path names the same document', () => {
    const rules = docRule(
      'exists(/databases/$(database)/documents/users/alice)'
        + " && get(/databases/$(database)/documents/users/bob).data.role == 'admin'",
    );
    expect(decide(rules, {
      method: 'get',
      path: 'items/1',
      functionMocks: [
        { function: 'exists', path: '/users/alice', result: true },
        { function: 'get', path: '/databases/(default)/documents/users/bob', result: { role: 'admin' } },
      ],
    })).toBe('ALLOW');
  });

  test('a get mock still answers exists() when exists is not mocked (unchanged)', () => {
    expect(decide(docRule('exists(/databases/$(database)/documents/users/alice)'), {
      method: 'get',
      path: 'items/1',
      functionMocks: [{ function: 'get', path: 'users/alice', result: { role: 'admin' } }],
    })).toBe('ALLOW');
  });
});

// FS-COV-6b. Production ORs every matching block: a sibling `{document=**}`
// read deny does not revoke a `match /menuItems/{id}` list grant. The
// corpus scenario `simcase-mock-and-path-fidelity` pins ALLOW for the
// document-path form the Rules Test API evaluates; the simulator's
// collection-path convenience form (`list menuItems`) must agree with it.
describe('collection-path list evaluates the document-level blocks', () => {
  const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if false;
    }
    match /menuItems/{id} {
      allow list: if true;
    }
  }
}`;

  test('a sibling recursive deny does not shadow the list grant', () => {
    expect(decide(rules, { method: 'list', path: 'menuItems/m1' })).toBe('ALLOW');
    expect(decide(rules, { method: 'list', path: 'menuItems' })).toBe('ALLOW');
  });

  test('a recursive-wildcard grant alone still answers a collection list', () => {
    const open = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow list: if true;
    }
  }
}`;
    expect(decide(open, { method: 'list', path: 'menuItems' })).toBe('ALLOW');
  });

  test('a recursive-wildcard deny alone still denies a collection list', () => {
    const closed = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow list: if false;
    }
  }
}`;
    expect(decide(closed, { method: 'list', path: 'menuItems' })).toBe('DENY');
  });
});

// FS-MET-6a. Before this fix the batch arm keyed getAfter/existsAfter on the
// normalized path, while the single-write arm compared the raw path string,
// so a 1-op batch and a single write gave different verdicts for one rule.
// The evidence is that surface disagreement (fs-verify-b/FS-MET-6.mjs). The
// Rules Test API cannot capture write projection, because getAfter needs a
// function mock there. Both arms now share one normalization: a leading
// slash and the `/databases/(default)/documents` prefix name the target.
// Firestore rejects `.` and `..` as document ids, so a path holding either
// segment errors in both arms rather than resolving to some document.
describe('getAfter/existsAfter: single-write and batch arms agree', () => {
  const run = (condition: string, batch: boolean) => {
    const rules = itemsRules(condition, 'create');
    const r = handler.simulate(
      rules,
      [{ description: 'case', expectation: 'ALLOW', method: 'create', path: 'items/i1', data: { name: 'A' } }],
      batch ? { batchProjection: new Map([['items/i1', { name: 'A' }]]) } : undefined,
    );
    if (!r.success) throw new Error(r.error.message);
    return r.data.results[0]!.decision;
  };

  for (const condition of [
    "getAfter(path('/items/' + id)).data.name == 'A'",
    "existsAfter(path('/items/' + id))",
    "getAfter(/databases/$(database)/documents/items/$(id)).data.name == 'A'",
  ]) {
    test(`ALLOW in both arms: ${condition}`, () => {
      expect([run(condition, false), run(condition, true)]).toEqual(['ALLOW', 'ALLOW']);
    });
  }

  for (const condition of [
    "getAfter(/databases/$(database)/documents/items/./$(id)).data.name == 'A'",
    'existsAfter(/databases/$(database)/documents/items/./$(id))',
    "getAfter(/databases/$(database)/documents/other/../items/$(id)).data.name == 'A'",
  ]) {
    test(`DENY in both arms: ${condition}`, () => {
      expect([run(condition, false), run(condition, true)]).toEqual(['DENY', 'DENY']);
    });
  }
});
