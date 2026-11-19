import { row } from './section.ts';

export default row({
  order: 350,
  featureKeys: ["evaluateStorageRules"],
  behavior: "CEL types the top-level `allow` condition as bool: a non-boolean result is an evaluation error that denies the rule and lets the walk continue to the next rule, rather than a JavaScript truthiness coercion",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "BORN UNVERIFIED, 2026-09-08: the local evaluator follows CEL's boolean typing of the allow boundary and the pinned Firestore capture `oracle:rules-firestore-strict-boolean-control-flow`, which records production denying three direct non-boolean conditions under `cloud.firestore` (registry row #188). No Storage capture pins the same position under `firebase.storage` yet. Corpus scenario `strict-boolean-allow-and-ternary` is the capture that would verify this row; `unit:storage/sandbox/rules-evaluator.test.ts` pins the local behavior in the meantime. VERIFIED, 2026-10-27: `oracle:rules-storage-strict-boolean-allow-and-ternary` captures the scenario under `firebase.storage` (5 cases), and the evaluator agrees on all 5; `unit:storage/rules-oracle-conformance.test.ts` replays them with no pin.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-strict-boolean-allow-and-ternary"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-evaluator.test.ts",
  ],
});
