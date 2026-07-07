/**
 * `experiment/conformance` — the held-out success oracle for the strategy
 * experiment (plans/draft-then-validate-experiment.md, B3/B4).
 *
 * Methodological contract: this oracle's cases are authored in the
 * fixtures and are NEVER shown to a strategy. The draft-then-validate
 * strategy generates its OWN validation cases internally; grading it on a
 * *separate* held-out matrix is what keeps the correctness hypothesis (H2)
 * falsifiable — otherwise the strategy would be scored on exactly what it
 * optimizes.
 *
 * The oracle is strategy-agnostic: it extracts the final ruleset from the
 * run (the workspace `rules` field if a tool wrote it — the ReAct path —
 * else the last ```firestore fence in the assistant text — the
 * draft-validate path), runs the real Firestore Rules simulator over each
 * held-out case, and passes iff every case's decision matches `expect`.
 *
 * Node- and browser-safe (the simulator is pure). No API spend.
 */
import type { RunSnapshot, SpecRegistry, SpecResult } from '@inbrowser/agent';
import { SimulateFirestoreRulesHandler, type TestCase } from 'pyric/rules';
import { parseRules } from '~/lib/agent/strategies/draft-then-validate';

export const CONFORMANCE_SPEC_NAME = 'experiment/conformance';

type Method = 'get' | 'list' | 'create' | 'update' | 'delete';

export interface ConformanceCase {
  method: Method;
  path: string;
  auth: { uid: string; token?: Record<string, unknown> } | null;
  data?: Record<string, unknown>;
  resource?: Record<string, unknown>;
  expect: 'ALLOW' | 'DENY';
}

interface ConformanceArgs {
  cases: ConformanceCase[];
}

/** Pull the ruleset to grade out of a run, tolerating both strategy
 *  shapes. Prefers a workspace ruleset (written by a tool); falls back to
 *  the assistant text's fenced rules. */
export function extractFinalRules(snapshot: RunSnapshot): string | null {
  const ws = (snapshot.finalWorkspace as { rules?: unknown } | undefined)?.rules;
  if (
    typeof ws === 'string' &&
    /rules_version|service\s+cloud\.firestore|\ballow\b/.test(ws)
  ) {
    return ws;
  }
  return parseRules(snapshot.assistantText ?? '');
}

function buildTestCase(c: ConformanceCase): TestCase {
  const tc: TestCase = {
    description: `conformance ${c.method} ${c.path}`,
    // Always 'ALLOW' so the simulator runs; we read the actual decision
    // off the result and compare to `c.expect` ourselves (mirrors the
    // playground simulate tool).
    expectation: 'ALLOW',
    method: c.method,
    path: c.path,
    auth: c.auth,
  };
  if (c.data !== undefined) tc.data = c.data;
  if (c.resource !== undefined) tc.resource = c.resource;
  return tc;
}

/** Run one case through the simulator and read its decision. */
function decide(sim: SimulateFirestoreRulesHandler, rules: string, c: ConformanceCase): string {
  const res = sim.simulate(rules, [buildTestCase(c)]);
  if (!res.success) return 'PARSE_FAILED';
  const tr = res.data?.results?.[0] as { decision?: string } | undefined;
  return tr?.decision ?? 'UNSUPPORTED';
}

/** The spec fn. Returns `{ ok, detail }`; never throws (a parse failure
 *  or unsupported decision just fails the affected case). */
export function conformanceSpec(snapshot: RunSnapshot, args: unknown): SpecResult {
  const cases = (args as ConformanceArgs | undefined)?.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    return { ok: false, error: 'conformance spec: no cases supplied' };
  }
  const rules = extractFinalRules(snapshot);
  if (!rules) {
    return { ok: false, error: 'conformance spec: no ruleset produced by the run' };
  }
  const sim = new SimulateFirestoreRulesHandler();
  const failures: Array<ConformanceCase & { got: string }> = [];
  for (const c of cases) {
    const got = decide(sim, rules, c);
    if (got !== c.expect) failures.push({ ...c, got });
  }
  return {
    ok: failures.length === 0,
    detail: {
      total: cases.length,
      passed: cases.length - failures.length,
      failures: failures.map((f) => ({ method: f.method, path: f.path, expect: f.expect, got: f.got })),
    },
  };
}

/** Register the oracle on a spec registry (call after `registerAllSpecs`
 *  so the experiment's fixtures resolve `experiment/conformance`). */
export function registerConformanceSpec(registry: SpecRegistry): void {
  registry.register(CONFORMANCE_SPEC_NAME, conformanceSpec);
}
