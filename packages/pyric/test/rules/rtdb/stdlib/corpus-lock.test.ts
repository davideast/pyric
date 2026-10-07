/**
 * The production captures of the standard library, tied to the builders and
 * to the sandbox.
 *
 * Each scenario deploys a fixture's paths compiled to JSON. The lock fails
 * when the builders compile to anything else, so a change to a builder's
 * output needs a new capture. Every captured case then runs through
 * `rtdbRules(json).simulate` and the sandbox, mounted under the scenario id
 * as the capture runner mounts it, and both must give production's verdict.
 */
import { describe, expect, test } from 'bun:test';
import { defineRtdbRules, rtdbRules, type PathDef } from 'pyric/rules';
import { ALL_RULES_RTDB_SCENARIOS } from '../../../../../conformance/rules-corpus/rtdb/index.ts';
import { CORE_PATTERN_PATHS } from './fixtures/match-rules.js';
import { PRESENCE_TIMING_PATHS } from './fixtures/presence-timing-rules.js';
import { sandboxCase, simulateCase, type StdlibCase, type StdlibScenario } from './harness.js';

const UID = 'corpus-user';

const CAPTURES: Array<{ id: string; paths: Record<string, PathDef> }> = [
  { id: 'r27-stdlib-core-patterns', paths: CORE_PATTERN_PATHS },
  { id: 'r28-stdlib-presence-timing', paths: PRESENCE_TIMING_PATHS },
];

// Pinned in rules-conformance.test.ts: the local engines compute with null
// where production fails the rule. The builders never compute with null.
const LOCAL_DIVERGENCES: Record<string, 'ALLOW' | 'DENY'> = Object.fromEntries(
  [
    'an unguarded step adds 1 to nothing stored',
    'adding 1 to nothing stored, then or true',
    'adding nothing stored to 1, then or true',
    'subtracting 1 from nothing stored, then or true',
    'multiplying nothing stored by 2, then or true',
    'adding a string to nothing stored, then or true',
    'negating nothing stored, then or true',
    'comparing nothing stored with 1, then or true',
  ].map((description) => [`r27-stdlib-core-patterns :: ${description}`, 'ALLOW']),
);

function substitute<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null).replaceAll('<UID>', UID)) as T;
}

function seedTree(id: string, seed: Record<string, unknown> | undefined): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(seed ?? {})) {
    const segments = [id, ...substitute(path).split('/').filter(Boolean)];
    let cursor = root;
    for (const segment of segments.slice(0, -1)) {
      cursor[segment] ??= {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1]!] = substitute(value);
  }
  return root;
}

for (const { id, paths } of CAPTURES) {
  const scenario = ALL_RULES_RTDB_SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`corpus scenario ${id} is missing`);
  const subtree = JSON.parse(scenario.rules) as Record<string, unknown>;
  const mounted: StdlibScenario = {
    json: { rules: { '.read': false, '.write': false, [id]: subtree } },
    cases: scenario.cases.map((c): StdlibCase => ({
      description: c.description,
      expectation: c.expectation,
      operation: c.operation,
      path: `/${id}${substitute(c.opPath)}`.replace(/\/$/, ''),
      auth: c.authPresent ? UID : null,
      data: seedTree(id, c.seed),
      ...(c.newData === undefined ? {} : { newData: substitute(c.newData) }),
    })),
  };

  describe(id, () => {
    test('the deployed ruleset is what the standard library compiles to', () => {
      const { probes: _probes, ...patterns } = subtree;
      expect(patterns).toEqual(rtdbRules(defineRtdbRules({ paths })).toJSON().rules);
    });

    for (const c of mounted.cases) {
      const local = LOCAL_DIVERGENCES[`${id} :: ${c.description}`] ?? c.expectation;
      test(`${c.expectation} in production: ${c.description}`, async () => {
        expect(simulateCase(mounted, c)).toBe(local);
        expect(await sandboxCase(mounted, c)).toBe(local);
      });
    }
  });
}
