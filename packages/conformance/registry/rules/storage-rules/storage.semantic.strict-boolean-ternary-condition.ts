import { row } from './section.ts';

export default row({
  order: 360,
  featureKeys: ["evaluateStorageRules"],
  behavior: "CEL types a ternary CONDITION as bool: a non-boolean condition produces an evaluation error that propagates like any other rules error, so `|| true` and a negated `&& false` both absorb it",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "BORN UNVERIFIED, 2026-09-08: the local evaluator follows CEL's boolean typing of the ternary condition and the pinned Firestore capture `oracle:rules-firestore-strict-boolean-control-flow`, whose three tautological error discriminators still DENY under `cloud.firestore` (registry row #188). No Storage capture pins the same position under `firebase.storage` yet. Corpus scenario `strict-boolean-allow-and-ternary` consumes the error through `|| true` and `!(… && false)` and is the capture that would verify this row; `unit:storage/sandbox/rules-evaluator.test.ts` pins the local behavior in the meantime. VERIFIED, 2026-10-27: `oracle:rules-storage-strict-boolean-allow-and-ternary` captures the scenario under `firebase.storage` (5 cases), and the evaluator agrees on all 5; `unit:storage/rules-oracle-conformance.test.ts` replays them with no pin.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-strict-boolean-allow-and-ternary"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-evaluator.test.ts",
  ],
});
