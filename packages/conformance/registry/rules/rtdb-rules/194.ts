import { row } from './section.ts';

export default row({
  order: 510,
  featureKeys: [],
  behavior: "`rtdbRules(...).simulate(cases)` returns `coverage`: each `.read`, `.write`, `.validate` and `.indexOn` node is reported as allow, deny, error, mixed, unsupported or never evaluated, with per-outcome counts, per-file and per-kind totals that include unsupported nodes, the indexes a read case's query needed but no node declares, and, given the rules source text, the line of each rule key",
  status: "conforms",
  evidence: "`unit:rules/rtdb/coverage.test.ts` pins a suite that exercises two of three rules (the third is never evaluated), a validate rule that only denied, one that allowed and denied, one that raised at evaluation, a rule the simulator cannot evaluate (status unsupported, counted in the totals so covered, never-evaluated and unsupported nodes sum to the total), a read cascade that stops at a granting ancestor (rules below it stay unevaluated), `.indexOn` use and `missingIndexes` derived from a read case's query, a suite that reaches full coverage, per-file totals and line numbers. Coverage is computed from the per-rule evaluation trace, whose agreement with the replayed production verdicts `unit:conformance/rules-rtdb-replay.test.ts` checks. Rule coverage is Pyric tooling: production reports no rule evaluation record, so there is no production observation to replay.",
  automation: "sandbox-only",
  queryable: false,
  exceptionReason: "test-suite tooling; production rules results carry no per-rule evaluation record",
  conformanceTests: [
    "packages/rules/test/rtdb/coverage.test.ts",
    "packages/conformance/src/rules-rtdb-replay.test.ts",
  ],
});
