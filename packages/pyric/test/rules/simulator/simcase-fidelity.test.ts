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
