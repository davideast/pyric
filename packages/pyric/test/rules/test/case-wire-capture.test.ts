/**
 * Replays the Rules Test API capture in `fixtures/case-wire/captures.json`
 * (`packages/conformance/src/capture-rules-case-wire.ts`) against pyric's
 * case handling (#1338).
 *
 *   - `create-with-resource` (FS2-CON-12): production binds a create case's
 *     `resource`, which no real create has, so pyric refuses the case in both
 *     engines, and a create without one gets production's verdicts.
 *   - `tagged-map` (FS2-CON-5): production reads `{__type: 'timestamp', ...}`
 *     as a map, and so does `simulate()`.
 *   - `wire-forms`: `buildApiTestCase` sends each value helper in the form
 *     production reads as that type, and `simulate()` reads the helper value
 *     as production reads the form.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { duration, firestoreRules, latlng, reference, timestamp, type FirestoreCase } from '../../../src/rules/index.js';
import { buildApiTestCase, type TestCase } from '../../../src/rules/test/spec.js';

interface CaseRecord {
  description: string;
  wire: { request: { path: string; resource?: { data: Record<string, unknown> } }; resource?: { data: Record<string, unknown> } };
  decision: 'ALLOW' | 'DENY';
}

interface Fixture { probes: Record<string, { rules: string; cases: CaseRecord[] }> }

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
  return {
    description: record.description,
    expectation: 'ALLOW',
    method: 'create',
    path,
    auth: { uid: 'alice' },
    ...(caseData ? { data: caseData } : {}),
    ...(record.wire.resource ? { resource: record.wire.resource.data } : {}),
  };
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
      expect(rules.simulate([tc]).cases[0]!.decision).toBe('UNSUPPORTED');
      expect(() => buildApiTestCase(tc as TestCase)).toThrow('a create case has no existing resource');
    }
  });

  test('a create without resource gets production verdicts', () => {
    for (const record of cases.filter((c) => c.wire.resource === undefined)) {
      expect([record.description, rules.simulate([caseFor(record)]).cases[0]!.decision]).toEqual([record.description, record.decision]);
    }
  });
});

describe('a plain map with a __type key (FS2-CON-5)', () => {
  test('simulate() reads it as production does, as a map', () => {
    const { rules, cases } = probe('tagged-map');
    for (const record of cases) {
      expect([record.description, rules.simulate([caseFor(record)]).cases[0]!.decision]).toEqual([record.description, record.decision]);
    }
  });

  test('buildApiTestCase sends it unchanged', () => {
    const record = captured('tagged-map', '{__type: timestamp} map is map');
    expect(buildApiTestCase(caseFor(record) as TestCase).request).toEqual(record.wire.request as never);
  });
});

describe('value helpers on the wire', () => {
  const { rules } = probe('wire-forms');
  const helpers: Array<[label: string, value: unknown, simulated: boolean]> = [
    ['timestamp form', timestamp('2026-01-01T00:00:00.123Z'), true],
    ['latlng form', latlng(1.5, -2), true],
    ['duration form', duration(-1500, 'ms'), true],
    // The simulator's reference value does not yet read as `path`
    // (filed from #1338), so only its wire form is checked here.
    ['reference form', reference('users/alice'), false],
  ];

  for (const [label, value, simulated] of helpers) {
    const records = fixture.probes['wire-forms']!.cases.filter((c) => c.description.startsWith(label));

    test(`${label}: buildApiTestCase sends what was captured`, () => {
      for (const record of records) {
        const built = buildApiTestCase(caseFor(record, { v: value }) as TestCase);
        expect(built.request.resource).toEqual(record.wire.request.resource!);
      }
    });

    if (!simulated) continue;
    test(`${label}: simulate() reads the helper value as production reads its form`, () => {
      for (const record of records) {
        const decision = rules.simulate([caseFor(record, { v: value })]).cases[0]!.decision;
        expect([record.description, decision]).toEqual([record.description, record.decision]);
      }
    });
  }

  test('a base64 string is a string to production, so bytes have no wire form', () => {
    expect(captured('wire-forms', 'base64 string is bytes').decision).toBe('DENY');
    expect(captured('wire-forms', 'base64 string is string').decision).toBe('ALLOW');
  });
});
