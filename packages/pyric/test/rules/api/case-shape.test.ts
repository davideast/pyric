/**
 * A rules case means one request in `simulate()`, in the MCP
 * `firestore_simulate_rules` tool, and on the Rules Test API wire. A case
 * either engine would read as a different request is refused with a reason
 * instead of answered (#1338: FS2-CON-1, FS2-CON-2, FS2-CON-3, FS2-CON-5,
 * FS2-CON-6, FS2-CON-12).
 *
 * The production side of FS2-CON-5 and FS2-CON-12 is the Rules Test API
 * capture in `../test/fixtures/case-wire/captures.json`, read by
 * `../test/case-wire-capture.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { createDispatch, createToolRegistry } from '@inbrowser/agent';
import {
  duration,
  firestoreRules,
  latlng,
  timestamp,
  vector,
  type FirestoreCase,
} from '../../../src/rules/index.js';
import { createFirestoreRulesTools } from '../../../src/rules/internal/node.js';

const SOURCE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /open/{id} { allow read, write: if true; }
    match /deadline/{id} { allow read: if request.time < timestamp.date(2030, 1, 1); }
    match /paths/{id} { allow get: if request.path == /databases/(default)/documents/paths/p1; }
    match /created/{id} { allow create: if resource.data.x == 1 || resource != null; }
    match /isTs/{id} { allow create: if request.resource.data.at is timestamp; }
    match /isMap/{id} { allow create: if request.resource.data.at is map; }
  }
}`;

const rules = firestoreRules(SOURCE);

function base(over: Record<string, unknown>): FirestoreCase {
  return { description: 'case', expectation: 'ALLOW', method: 'get', path: 'open/a', ...over } as FirestoreCase;
}

function only(over: Record<string, unknown>) {
  return rules.simulate([base(over)]).cases[0]!;
}

describe('simulate() refuses a malformed case as UNSUPPORTED with the reason (FS2-CON-2)', () => {
  test("method 'read' is refused, not allowed", () => {
    const r = only({ method: 'read' });
    expect(r.decision).toBe('UNSUPPORTED');
    expect(r.notes.join(' ')).toContain('method');
  });

  test('a missing path is refused, not thrown', () => {
    const tc = base({});
    delete (tc as Partial<FirestoreCase>).path;
    const summary = rules.simulate([tc]);
    expect(summary.cases[0]!.decision).toBe('UNSUPPORTED');
    expect(summary.cases[0]!.notes.join(' ')).toContain('path');
    expect(summary.unsupported).toBe(1);
  });

  test('a misspelled field is refused, naming it', () => {
    const r = only({ method: 'create', path: 'open/a', dta: { x: 1 } });
    expect(r.decision).toBe('UNSUPPORTED');
    expect(r.notes.join(' ')).toContain("unknown field 'dta'");
  });

  test('the counts still partition the cases', () => {
    const summary = rules.simulate([base({}), base({ method: 'read' })]);
    expect(summary.passed + summary.failed + summary.unsupported).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.unsupported).toBe(1);
  });
});

describe('requestTime must be an ISO-8601 instant with an offset (FS2-CON-3)', () => {
  test.each(['nope', '2026-01-01T00:00:00', '2026-01-01', 'Mon, 01 Jan 2026 00:00:00 GMT'])(
    '%p is refused, not evaluated at a NaN or local-time clock',
    (requestTime) => {
      const r = only({ path: 'deadline/a', requestTime });
      expect(r.decision).toBe('UNSUPPORTED');
      expect(r.notes.join(' ')).toContain('requestTime');
    },
  );

  test('an instant with Z or an offset evaluates', () => {
    expect(only({ path: 'deadline/a', requestTime: '2029-12-31T23:00:00Z' }).decision).toBe('ALLOW');
    expect(only({ path: 'deadline/a', requestTime: '2030-01-01T00:30:00+01:00' }).decision).toBe('ALLOW');
    expect(only({ path: 'deadline/a', requestTime: '2030-01-01T00:00:00.000000001Z' }).decision).toBe('DENY');
  });
});

describe('a create case names no existing resource (FS2-CON-12)', () => {
  test('create with resource is refused with the reason', () => {
    const r = only({ method: 'create', path: 'created/a', data: { x: 2 }, resource: { x: 1 } });
    expect(r.decision).toBe('UNSUPPORTED');
    expect(r.notes).toEqual([
      "Case refused: a create case has no existing resource; use 'update' or remove 'resource'.",
    ]);
  });

  test('create without resource evaluates resource as null', () => {
    expect(only({ method: 'create', path: 'created/a', data: { x: 2 }, expectation: 'DENY' }).decision).toBe('DENY');
  });
});

describe('a full-form path is one request path (FS2-CON-1)', () => {
  test('request.path is not doubled for the full resource name', () => {
    expect(only({ path: '/databases/(default)/documents/paths/p1' }).decision).toBe('ALLOW');
    expect(only({ path: 'paths/p1' }).decision).toBe('ALLOW');
  });
});

describe('only a value helper is a typed value (FS2-CON-5)', () => {
  const at = { __type: 'timestamp', seconds: 1767225600, nanos: 0 };

  test('a plain map with a __type key is a map, as production reads it', () => {
    expect(only({ method: 'create', path: 'isTs/a', data: { at } }).decision).toBe('DENY');
    expect(only({ method: 'create', path: 'isMap/a', data: { at } }).decision).toBe('ALLOW');
  });

  test('a timestamp() value is a timestamp', () => {
    const data = { at: timestamp('2026-01-01T00:00:00Z') };
    expect(only({ method: 'create', path: 'isTs/a', data }).decision).toBe('ALLOW');
  });
});

describe('value helpers refuse impossible values (FS2-CON-6)', () => {
  test.each([
    ['timestamp("nope")', () => timestamp('nope')],
    ['timestamp without an offset', () => timestamp('2026-01-01T00:00:00')],
    ['timestamp(NaN)', () => timestamp(Number.NaN)],
    ['timestamp(invalid Date)', () => timestamp(new Date('nope'))],
    ['latlng(91, 0)', () => latlng(91, 0)],
    ['latlng(0, -181)', () => latlng(0, -181)],
    ['duration(NaN)', () => duration(Number.NaN)],
    ['vector([NaN])', () => vector([Number.NaN])],
  ])('%s throws a TypeError', (_name, make) => {
    expect(make).toThrow(TypeError);
  });

  test('in-range values build', () => {
    expect(timestamp(new Date(0)).seconds).toBe(0);
    expect(latlng(90, -180).lat).toBe(90);
    expect(duration(2).seconds).toBe(2);
    expect(vector([1, 2]).value).toEqual([1, 2]);
  });
});

describe('the MCP firestore_simulate_rules tool checks cases the same way', () => {
  const dispatch = (() => {
    const registry = createToolRegistry();
    for (const t of createFirestoreRulesTools()) registry.register(t);
    return createDispatch(registry);
  })();

  async function simulateTool(testCases: unknown[]) {
    const out = await dispatch.execute(
      { id: '1', name: 'firestore_simulate_rules', args: { source: SOURCE, testCases } },
      { signal: new AbortController().signal },
    );
    const data = out.data as { data: { results: Array<{ decision: string; notes: string[] }> } };
    return data.data.results;
  }

  test("method 'read', a missing path, and a misspelled field are UNSUPPORTED", async () => {
    const results = await simulateTool([
      { description: 'read', expectation: 'ALLOW', method: 'read', path: 'open/a' },
      { description: 'no path', expectation: 'ALLOW', method: 'get' },
      { description: 'typo', expectation: 'ALLOW', method: 'get', path: 'open/a', requestTme: '2026-01-01T00:00:00Z' },
    ]);
    expect(results.map((r) => r.decision)).toEqual(['UNSUPPORTED', 'UNSUPPORTED', 'UNSUPPORTED']);
    expect(results[2]!.notes.join(' ')).toContain("'requestTme'");
  });

  test('a create case with resource is UNSUPPORTED, and a __type map is a map', async () => {
    const at = { __type: 'timestamp', seconds: 1, nanos: 0 };
    const results = await simulateTool([
      { description: 'c', expectation: 'DENY', method: 'create', path: 'created/a', data: {}, resource: { x: 1 } },
      { description: 'm', expectation: 'ALLOW', method: 'create', path: 'isMap/a', data: { at } },
    ]);
    expect(results.map((r) => r.decision)).toEqual(['UNSUPPORTED', 'ALLOW']);
  });
});
