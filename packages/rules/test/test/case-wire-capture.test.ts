/**
 * Replays the Rules Test API capture in `fixtures/case-wire/captures.json`
 * (`packages/conformance/src/capture-rules-case-wire.ts`) against pyric's
 * case handling (#1338, #1450).
 *
 *   - `create-with-resource` (FS2-CON-12): production binds a create case's
 *     `resource`, which no real create has, so pyric refuses the case in both
 *     engines, and a create without one gets production's verdicts.
 *   - `tagged-map` (FS2-CON-5): production reads `{__type: 'timestamp', ...}`
 *     as a map, and so does `simulate()`.
 *   - `wire-forms`: `buildApiTestCase` sends each value helper in the form
 *     production reads as that type, and `simulate()` reads the helper value
 *     as production reads the form.
 *   - `string-sniffing` (#1450): production sniffs ISO strings with an offset,
 *     seconds strings (`"5s"`), leading-`"/"` strings, and exact 2-key
 *     `{latitude, longitude}` maps as typed values, so `buildApiTestCase`
 *     refuses them by field name while preserving non-offset ISO strings and
 *     3-key maps as written.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { duration, firestoreRules, latlng, reference, timestamp, type FirestoreCase } from '../../src/index.js';
import { buildApiTestCase, type TestCase } from '../../src/test/spec.js';

interface CaseRecord {
  description: string;
  wire: {
    request: { path: string; resource?: { data: Record<string, unknown> } };
    resource?: { data: Record<string, unknown> };
  };
  decision: 'ALLOW' | 'DENY';
}

interface Fixture {
  probes: Record<string, { rules: string; cases: CaseRecord[] }>;
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures/case-wire/captures.json'), 'utf-8'),
) as Fixture;

function probe(name: string) {
  const p = fixture.probes[name];
  if (!p) throw new Error(`no probe ${name}`);
  return { rules: firestoreRules(p.rules), cases: p.cases };
}

function captured(name: string, description: string): CaseRecord {
  const found = fixture.probes[name]?.cases.find((c) => c.description === description);
  if (!found) throw new Error(`no case ${description}`);
  return found;
}

/** The pyric case a captured wire case stands for, with `data` in place of the wire's. */
function caseFor(record: CaseRecord, data?: Record<string, unknown>): FirestoreCase {
  const path = record.wire.request.path.replace('/databases/(default)/documents/', '');
  const caseData = data ?? record.wire.request.resource?.data;
  const out: FirestoreCase = {
    description: record.description,
    expectation: 'ALLOW',
    method: 'create',
    path,
    auth: { uid: 'alice' },
  };
  if (caseData !== undefined) {
    out.data = caseData;
  }
  if (record.wire.resource !== undefined) {
    out.resource = record.wire.resource.data;
  }
  return out;
}

describe('create with resource (FS2-CON-12)', () => {
  const { rules, cases } = probe('create-with-resource');

  test('production binds a create case resource', () => {
    expect(captured('create-with-resource', 'create with resource: resource.data.x == 1').decision).toBe('ALLOW');
    expect(captured('create-with-resource', 'create with resource: resource != null').decision).toBe('ALLOW');
  });

  test('pyric refuses each such case in simulate() and before the wire', () => {
    for (const record of cases.filter((c) => c.wire.resource !== undefined)) {
      const tc = caseFor(record);
      const first = rules.simulate([tc]).cases[0];
      expect(first?.decision).toBe('UNSUPPORTED');
      expect(() => buildApiTestCase(tc as TestCase)).toThrow('a create case has no existing resource');
    }
  });

  test('a create without resource gets production verdicts', () => {
    for (const record of cases.filter((c) => c.wire.resource === undefined)) {
      const first = rules.simulate([caseFor(record)]).cases[0];
      expect([record.description, first?.decision]).toEqual([record.description, record.decision]);
    }
  });
});

describe('a plain map with a __type key (FS2-CON-5)', () => {
  test('simulate() reads it as production does, as a map', () => {
    const { rules, cases } = probe('tagged-map');
    for (const record of cases) {
      const first = rules.simulate([caseFor(record)]).cases[0];
      expect([record.description, first?.decision]).toEqual([record.description, record.decision]);
    }
  });

  test('buildApiTestCase sends it unchanged', () => {
    const record = captured('tagged-map', '{__type: timestamp} map is map');
    expect(buildApiTestCase(caseFor(record) as TestCase).request).toEqual(record.wire.request as never);
  });
});

describe('value helpers on the wire', () => {
  const { rules } = probe('wire-forms');
  const wireCases = probe('wire-forms').cases;
  const helpers: Array<[label: string, value: unknown, simulated: boolean]> = [
    ['timestamp form', timestamp('2026-01-01T00:00:00.123Z'), true],
    ['latlng form', latlng(1.5, -2), true],
    ['duration form', duration(-1500, 'ms'), true],
    ['reference form', reference('users/alice'), true],
  ];

  for (const [label, value, simulated] of helpers) {
    const records = wireCases.filter((c) => c.description.startsWith(label));

    test(`${label}: buildApiTestCase sends what was captured`, () => {
      for (const record of records) {
        const built = buildApiTestCase(caseFor(record, { v: value }) as TestCase);
        expect(built.request.resource).toEqual(record.wire.request.resource);
      }
    });

    if (!simulated) continue;
    test(`${label}: simulate() reads the helper value as production reads its form`, () => {
      for (const record of records) {
        const decision = rules.simulate([caseFor(record, { v: value })]).cases[0]?.decision;
        expect([record.description, decision]).toEqual([record.description, record.decision]);
      }
    });
  }

  test('a base64 string is a string to production, so bytes have no wire form', () => {
    expect(captured('wire-forms', 'base64 string is bytes').decision).toBe('DENY');
    expect(captured('wire-forms', 'base64 string is string').decision).toBe('ALLOW');
  });
});

describe('plain strings and maps sniffed by the Rules Test API (#1450)', () => {
  const { rules } = probe('string-sniffing');

  test('captured production verdicts show the four sniffed shapes and two plain controls', () => {
    expect(captured('string-sniffing', 'ISO string with offset is string').decision).toBe('DENY');
    expect(captured('string-sniffing', 'ISO string with offset is timestamp').decision).toBe('ALLOW');
    expect(captured('string-sniffing', 'ISO string without offset is string').decision).toBe('ALLOW');
    expect(captured('string-sniffing', 'ISO string without offset is timestamp').decision).toBe('DENY');
    expect(captured('string-sniffing', 'seconds string is string').decision).toBe('DENY');
    expect(captured('string-sniffing', 'seconds string is duration').decision).toBe('ALLOW');
    expect(captured('string-sniffing', 'slash string is string').decision).toBe('DENY');
    expect(captured('string-sniffing', 'slash string is path').decision).toBe('ALLOW');
    expect(captured('string-sniffing', 'latitude and longitude map is map').decision).toBe('DENY');
    expect(captured('string-sniffing', 'latitude and longitude map is latlng').decision).toBe('ALLOW');
    expect(captured('string-sniffing', 'latitude and longitude map with another key is map').decision).toBe('ALLOW');
    expect(captured('string-sniffing', 'latitude and longitude map with another key is latlng').decision).toBe('DENY');
  });

  test('simulate() keeps all six inputs as the plain strings and maps they are', () => {
    for (const [isPlainDesc, isTypedDesc] of [
      ['ISO string with offset is string', 'ISO string with offset is timestamp'],
      ['ISO string without offset is string', 'ISO string without offset is timestamp'],
      ['seconds string is string', 'seconds string is duration'],
      ['slash string is string', 'slash string is path'],
      ['latitude and longitude map is map', 'latitude and longitude map is latlng'],
      ['latitude and longitude map with another key is map', 'latitude and longitude map with another key is latlng'],
    ] as const) {
      const plainRec = captured('string-sniffing', isPlainDesc);
      const typedRec = captured('string-sniffing', isTypedDesc);
      expect(rules.simulate([caseFor(plainRec)]).cases[0]?.decision).toBe('ALLOW');
      expect(rules.simulate([caseFor(typedRec)]).cases[0]?.decision).toBe('DENY');
    }
  });

  test('buildApiTestCase refuses the four sniffed shapes naming the field and sends the two plain controls unchanged', () => {
    for (const [desc, expectedSnippet] of [
      ['ISO string with offset is string', 'Case refused: data.v is an ISO-8601 instant string'],
      ['seconds string is string', 'Case refused: data.v is a seconds string ("5s")'],
      ['slash string is string', 'Case refused: data.v is a string starting with "/" ("/a/b")'],
      ['latitude and longitude map is map', 'Case refused: data.v is a {latitude, longitude} map'],
    ] as const) {
      const rec = captured('string-sniffing', desc);
      expect(() => buildApiTestCase(caseFor(rec) as TestCase)).toThrow(expectedSnippet);
    }

    for (const desc of [
      'ISO string without offset is string',
      'latitude and longitude map with another key is map',
    ] as const) {
      const rec = captured('string-sniffing', desc);
      expect(buildApiTestCase(caseFor(rec) as TestCase).request).toEqual(rec.wire.request as never);
    }

    expect(() =>
      buildApiTestCase({
        description: 'resource and mock field paths',
        expectation: 'ALLOW',
        method: 'update',
        path: 'docs/d1',
        resource: { nested: ['/a/b'] },
        data: { ok: true },
      }),
    ).toThrow('Case refused: resource.nested[0] is a string starting with "/"');

    expect(() =>
      buildApiTestCase({
        description: 'functionMock field path',
        expectation: 'ALLOW',
        method: 'get',
        path: 'docs/d1',
        functionMocks: [{ function: 'get', path: 'cfg/c', result: { ttl: '-1.5s' } }],
      }),
    ).toThrow('Case refused: functionMocks(cfg/c).result.ttl is a seconds string');
  });
});
