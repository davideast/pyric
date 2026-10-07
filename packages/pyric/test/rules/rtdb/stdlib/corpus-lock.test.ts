/**
 * The production capture of the standard library's main patterns, tied to
 * the builders and to the sandbox.
 *
 * `r27-stdlib-core-patterns` deploys `CORE_PATTERN_PATHS` compiled to JSON.
 * The lock fails when the builders compile to anything else, so a change to a
 * builder's output needs a new capture. Every captured case then runs through
 * `rtdbRules(json).simulate` and the sandbox, mounted under the scenario id
 * as the capture runner mounts it, and both must give production's verdict.
 */
import { describe, expect, test } from 'bun:test';
import { defineRtdbRules, rtdbRules } from 'pyric/rules';
import { ALL_RULES_RTDB_SCENARIOS } from '../../../../../conformance/rules-corpus/rtdb/index.ts';
import { CORE_PATTERN_PATHS } from './fixtures/match-rules.js';
import { sandboxCase, simulateCase, type StdlibCase, type StdlibScenario } from './harness.js';

const scenario = ALL_RULES_RTDB_SCENARIOS.find((s) => s.id === 'r27-stdlib-core-patterns');
if (!scenario) throw new Error('corpus scenario r27-stdlib-core-patterns is missing');

const UID = 'corpus-user';

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
  ].map((description) => [description, 'ALLOW']),
);
const subtree = JSON.parse(scenario.rules) as Record<string, unknown>;

function substitute<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null).replaceAll('<UID>', UID)) as T;
}

function seedTree(seed: Record<string, unknown> | undefined): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(seed ?? {})) {
    const segments = [scenario!.id, ...substitute(path).split('/').filter(Boolean)];
    let cursor = root;
    for (const segment of segments.slice(0, -1)) {
      cursor[segment] ??= {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1]!] = substitute(value);
  }
  return root;
}

const mounted: StdlibScenario = {
  json: { rules: { '.read': false, '.write': false, [scenario.id]: subtree } },
  cases: scenario.cases.map((c): StdlibCase => ({
    description: c.description,
    expectation: c.expectation,
    operation: c.operation,
    path: `/${scenario.id}${substitute(c.opPath)}`,
    auth: c.authPresent ? UID : null,
    data: seedTree(c.seed),
    ...(c.newData === undefined ? {} : { newData: substitute(c.newData) }),
  })),
};

describe('r27-stdlib-core-patterns', () => {
  test('the deployed ruleset is what the standard library compiles to', () => {
    const { probes: _probes, ...patterns } = subtree;
    const compiled = rtdbRules(defineRtdbRules({ paths: CORE_PATTERN_PATHS })).toJSON();
    expect(patterns).toEqual(compiled.rules);
  });

  for (const c of mounted.cases) {
    // Pinned in rules-conformance.test.ts: the local engines add to null where
    // production fails the rule. The builders never add to null.
    const local = LOCAL_DIVERGENCES[c.description] ?? c.expectation;
    test(`${c.expectation} in production: ${c.description}`, async () => {
      expect(simulateCase(mounted, c)).toBe(local);
      expect(await sandboxCase(mounted, c)).toBe(local);
    });
  }
});
