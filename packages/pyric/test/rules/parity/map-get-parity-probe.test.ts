/**
 * Parity probe for `Map.get(key, default)` — locks in *production's*
 * actual behavior against the live Rules Test API.
 *
 * Resurrected from the pre-cutover suite (deleted in be3c2b2; restored per
 * the design rationale §5 and round-3 track P3). Scenarios are
 * unchanged; only the bootstrap moved from `initializeAgentApp` to
 * `parityScope()` (firebase-admin cert credential from PARITY_SA_BASE64).
 *
 * Strategy: for each scenario we send rules to production —
 *   - `_eq_default`: allows if `m.get(key, 'SENTINEL') == 'SENTINEL'`
 *   - `_eq_null`:    allows if `m.get(key, 'SENTINEL') == null`
 *   - `_eq_value`:   (when a value is predicted) compares to the literal
 *
 * Whichever production ALLOWs reveals what `Map.get` returned. We assert
 * the specific outcome per scenario; if production behavior ever changes,
 * this probe flips to FAIL with a row that says exactly what shifted.
 * Locked-in behavior: production *always* returns `default` on any walk
 * failure (missing key, missing intermediate, non-map intermediate) —
 * never null.
 *
 * Requires: PARITY_SA_BASE64 in env — a minimal service account that
 * holds only `firebaserules.rulesets.test`. Skips cleanly when absent.
 */
import { describe, test, beforeAll, expect } from 'bun:test';
import type { ProjectScope } from 'pyric-tools/deploy';
import { TestFirestoreRulesHandler } from '../../../src/rules/test/handler.js';
import type { TestCase } from '../../../src/rules/test/spec.js';
import { hasParitySecret, parityScope } from './harness.js';

// ─── Probe scenarios ───────────────────────────────────────────────────────
//
// For each scenario, the request payload defines a `m` map and a key (or
// list-form key path). The rules below compare `m.get(key, 'SENTINEL')`
// to the sentinel string, null, or the literal value. Whichever ALLOWs is
// the truth.

interface Scenario {
  id: string;
  description: string;
  // The request payload that becomes request.resource.data
  data: Record<string, unknown>;
  // The key argument expression (literal source as written in rules)
  keyExpr: string;
  // Predicted return — used as the expectation in test cases.
  expectedReturn: 'default' | 'null' | 'value';
  // If expectedReturn === 'value', the literal value to compare against.
  expectedValue?: string;
}

const SENTINEL = 'SENTINEL_DEFAULT';

const SCENARIOS: Scenario[] = [
  {
    id: 'single_key_present',
    description: "m.get('a', SENTINEL) when m.a exists → returns m.a",
    data: { m: { a: 'X' } },
    keyExpr: "'a'",
    expectedReturn: 'value',
    expectedValue: 'X',
  },
  {
    id: 'single_key_absent',
    description: "m.get('z', SENTINEL) when m.z is absent → returns SENTINEL",
    data: { m: { a: 'X' } },
    keyExpr: "'z'",
    expectedReturn: 'default',
  },
  {
    id: 'list_form_leaf_present',
    description: "m.get(['a','b','c'], SENTINEL) when full path exists → returns leaf",
    data: { m: { a: { b: { c: 'X' } } } },
    keyExpr: "['a','b','c']",
    expectedReturn: 'value',
    expectedValue: 'X',
  },
  {
    id: 'list_form_leaf_absent',
    description: "m.get(['a','b','z'], SENTINEL) when parent map exists but leaf missing → returns SENTINEL",
    data: { m: { a: { b: { c: 'X' } } } },
    keyExpr: "['a','b','z']",
    expectedReturn: 'default',
  },
  {
    id: 'list_form_mid_absent',
    description: "m.get(['a','z','c'], SENTINEL) when intermediate map missing → SENTINEL (probe confirmed)",
    data: { m: { a: { b: { c: 'X' } } } },
    keyExpr: "['a','z','c']",
    expectedReturn: 'default',
  },
  {
    id: 'list_form_parent_absent',
    description: "m.get(['z','b','c'], SENTINEL) when top-level key missing → SENTINEL (probe confirmed)",
    data: { m: { a: { b: { c: 'X' } } } },
    keyExpr: "['z','b','c']",
    expectedReturn: 'default',
  },
  {
    id: 'list_form_mid_is_string',
    description: "m.get(['a','b'], SENTINEL) when m.a is a string (cannot descend into non-map) → SENTINEL",
    data: { m: { a: 'leaf-string' } },
    keyExpr: "['a','b']",
    expectedReturn: 'default',
  },
  {
    id: 'list_form_mid_is_int',
    description: "m.get(['a','b'], SENTINEL) when m.a is an int (cannot descend into non-map) → SENTINEL",
    data: { m: { a: 7 } },
    keyExpr: "['a','b']",
    expectedReturn: 'default',
  },
];

// ─── Build rules + test cases ──────────────────────────────────────────────

function buildRules(scenarios: Scenario[]): string {
  const matches = scenarios.flatMap(s => {
    const path = `${s.id}_eq_default/{id}`;
    const path2 = `${s.id}_eq_null/{id}`;
    const path3 = s.expectedValue !== undefined ? `${s.id}_eq_value/{id}` : null;
    const blocks: string[] = [
      `    match /${path} {
      allow create: if request.resource.data.m.get(${s.keyExpr}, '${SENTINEL}') == '${SENTINEL}';
    }`,
      `    match /${path2} {
      allow create: if request.resource.data.m.get(${s.keyExpr}, '${SENTINEL}') == null;
    }`,
    ];
    if (path3 && s.expectedValue !== undefined) {
      blocks.push(
        `    match /${path3} {
      allow create: if request.resource.data.m.get(${s.keyExpr}, '${SENTINEL}') == '${s.expectedValue}';
    }`,
      );
    }
    return blocks;
  });
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${matches.join('\n')}
  }
}`;
}

interface CaseMeta {
  scenarioId: string;
  variant: 'eq_default' | 'eq_null' | 'eq_value';
}

function buildCases(scenarios: Scenario[]): { cases: TestCase[]; meta: CaseMeta[] } {
  const cases: TestCase[] = [];
  const meta: CaseMeta[] = [];
  for (const s of scenarios) {
    const variants: CaseMeta['variant'][] = ['eq_default', 'eq_null'];
    if (s.expectedValue !== undefined) variants.push('eq_value');
    for (const v of variants) {
      cases.push({
        description: `${s.id} :: ${v}`,
        // We expect ALLOW for the variant matching expectedReturn,
        // DENY for the other(s). We send all as ALLOW and inspect actuals.
        expectation: 'ALLOW',
        method: 'create',
        path: `${s.id}_${v}/d1`,
        auth: { uid: 'alice' },
        data: s.data,
      });
      meta.push({ scenarioId: s.id, variant: v });
    }
  }
  return { cases, meta };
}

// ─── Test ──────────────────────────────────────────────────────────────────

const HAS_SA = hasParitySecret();
let scope: ProjectScope;

beforeAll(() => {
  if (!HAS_SA) return;
  scope = parityScope();
});

describe.skipIf(!HAS_SA)('Map.get parity probe (Item 0.H)', () => {
  test('production behavior locked in across scenarios', async () => {
    const rules = buildRules(SCENARIOS);
    const { cases, meta } = buildCases(SCENARIOS);

    const prod = new TestFirestoreRulesHandler();
    const res = await prod.execute(scope, rules, cases);

    if (!res.success) {
      throw new Error(
        `Prod Test API failed: ${res.error.code} ${res.error.message}`,
      );
    }

    // Build a per-scenario verdict map.
    const verdicts: Record<string, Partial<Record<CaseMeta['variant'], 'ALLOW' | 'DENY'>>> = {};
    res.data.results.forEach((r, i) => {
      const m = meta[i];
      // expectation was ALLOW everywhere; PASSED means prod actual = ALLOW.
      const actual = r.state === 'PASSED' ? 'ALLOW' : 'DENY';
      verdicts[m.scenarioId] = { ...verdicts[m.scenarioId], [m.variant]: actual };
    });

    // Print the table for the run log — this is the artifact 0.H wants.
    console.log('\n═══ Map.get parity probe — production verdicts ═══');
    for (const s of SCENARIOS) {
      const v = verdicts[s.id];
      const returned =
        v.eq_value === 'ALLOW' ? `value(${s.expectedValue})` :
        v.eq_default === 'ALLOW' ? 'default' :
        v.eq_null === 'ALLOW' ? 'null' :
        '???';
      console.log(`  [${s.id.padEnd(24)}] returned=${returned.padEnd(14)} :: ${s.description}`);
    }
    console.log('═══════════════════════════════════════════════════\n');

    // Assertions — lock in production behavior.
    // If prod ever changes, the failing row tells us exactly what shifted.
    for (const s of SCENARIOS) {
      const v = verdicts[s.id];
      if (s.expectedReturn === 'value') {
        expect(v.eq_value, `${s.id}: expected to return value '${s.expectedValue}'`).toBe('ALLOW');
        expect(v.eq_default, `${s.id}: should NOT match default when value present`).toBe('DENY');
        expect(v.eq_null, `${s.id}: should NOT match null when value present`).toBe('DENY');
      } else if (s.expectedReturn === 'default') {
        expect(v.eq_default, `${s.id}: expected to return default`).toBe('ALLOW');
        expect(v.eq_null, `${s.id}: should NOT match null when default returned`).toBe('DENY');
      } else if (s.expectedReturn === 'null') {
        expect(v.eq_null, `${s.id}: expected to return null`).toBe('ALLOW');
        expect(v.eq_default, `${s.id}: should NOT match default when null returned`).toBe('DENY');
      }
    }
  }, 30000);
});
