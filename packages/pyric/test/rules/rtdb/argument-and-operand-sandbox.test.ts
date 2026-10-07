/**
 * The r32-method-argument-types and r33-null-operands captures, replayed
 * through `rtdbRules(json).simulate` and through the sandbox. Each case is
 * mounted under its scenario id, as the capture runner mounts it, and both
 * must give production's verdict.
 */
import { describe, expect, test } from 'bun:test';
import { ALL_RULES_RTDB_SCENARIOS } from '../../../../conformance/rules-corpus/rtdb/index.ts';
import type { RtdbScenario, RtdbTestCase } from '../../../../conformance/rules-corpus/rtdb/index.ts';
import { sandboxCase, simulateCase, type StdlibCase, type StdlibScenario } from './stdlib/harness.js';

const UID = 'corpus-user';

function substitute<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null).replaceAll('<UID>', UID)) as T;
}

/** The stored tree for a case: its seed, plus its mockData at the operation path. */
function storedTree(scenario: RtdbScenario, c: RtdbTestCase): Record<string, unknown> {
  const entries = Object.entries(c.seed ?? {});
  if (c.mockData !== undefined) entries.push([c.opPath, c.mockData]);
  const root: Record<string, unknown> = {};
  for (const [path, value] of entries) {
    const segments = [scenario.id, ...substitute(path).split('/').filter(Boolean)];
    let cursor = root;
    for (const segment of segments.slice(0, -1)) {
      cursor[segment] ??= {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1]!] = substitute(value);
  }
  return root;
}

function mount(scenario: RtdbScenario): StdlibScenario {
  return {
    json: { rules: { '.read': false, '.write': false, [scenario.id]: JSON.parse(scenario.rules) } },
    cases: scenario.cases.map((c): StdlibCase => ({
      description: c.description,
      expectation: c.expectation,
      operation: c.operation,
      path: `/${scenario.id}${substitute(c.opPath)}`,
      auth: c.authPresent ? UID : null,
      data: storedTree(scenario, c),
      ...(c.newData === undefined ? {} : { newData: substitute(c.newData) }),
    })),
  };
}

for (const id of ['r32-method-argument-types', 'r33-null-operands']) {
  const scenario = ALL_RULES_RTDB_SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`corpus scenario ${id} is missing`);
  const mounted = mount(scenario);
  describe(id, () => {
    for (const c of mounted.cases) {
      test(`${c.expectation} in production: ${c.description}`, async () => {
        expect(simulateCase(mounted, c)).toBe(c.expectation);
        expect(await sandboxCase(mounted, c)).toBe(c.expectation);
      });
    }
  });
}
