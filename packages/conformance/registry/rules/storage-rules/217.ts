import { row } from './section.ts';

export default row({
  order: 550,
  featureKeys: ["parseStorageRules"],
  behavior: "One `service firebase.storage` may hold more than one top-level `match` block, one per bucket (ST-H2-8)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-storage-two-top-level-bucket-matches` (captured 2026-10-27, 2 cases) records production compiling two top-level match blocks, ALLOWING `get` in the named bucket's block and DENYING the other bucket under the wildcard block. `ServiceBlock` accepts multiple top-level `match` blocks and agrees on both cases.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["pyric refuses a ruleset production deploys"],
  oracleObservations: ["rules-storage-storage-two-top-level-bucket-matches"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/grammar/multiple-root-matches.test.ts",
  ],
  constructs: ["storage.rule-kind.match"],
});
