import { row } from './section.ts';

export default row({
  order: 300,
  featureKeys: ["request.auth"],
  behavior: "Anonymous `request.auth != null` used as a ternary condition before a cross-service lookup",
  status: "conforms",
  evidence: "GAP CLOSED, 2026-07-21: anonymous `request.auth` is now represented as an absent-property Rules error, so a ternary condition denies before selecting either lookup branch, matching hosted diagnostics. `oracle:rules-storage-firestore-lookup-budget` replays the captured DENY directly with no divergence pin; `unit:storage/sandbox/rules-methods.test.ts` covers the lookup evaluator seam.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-firestore-lookup-budget"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
  constructs: ["storage.binding.request.auth", "storage.operator.ternary"],
});
