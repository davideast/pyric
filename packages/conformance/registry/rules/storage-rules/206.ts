import { row } from './section.ts';

export default row({
  order: 440,
  featureKeys: ["rules_version"],
  behavior: "Without `rules_version = '2'`, a recursive wildcard needs at least one segment (ST-H1-2)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-h1-v1-recursive-wildcard` (captured 2026-10-27, 4 cases) records production DENYING `v1 glob: zero segments for the glob deny` and ALLOWING the other 3. The evaluator agrees on all 4: under `rules_version = '1'`, the default, a recursive wildcard needs one or more segments (`recursiveWildcardMinimum` in `rules-path-match.ts`, #1330). `unit:storage/rules-oracle-conformance.test.ts` replays them with no pin, and `unit:storage/sandbox/rules-v1-recursive-wildcard.test.ts` covers versions 1 and 2.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-h1-v1-recursive-wildcard"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-v1-recursive-wildcard.test.ts",
  ],
  constructs: ["storage.rule-kind.rules_version", "storage.semantic.recursive-wildcard"],
});
