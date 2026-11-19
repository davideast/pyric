import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Auto-id format — production and sandbox mint 20-character IDs from `[A-Za-z0-9]`",
  status: "conforms",
  evidence: "Oracle-locked: `packages/conformance/observations/firestore/firestore-adddoc-autoid-format.json` records production's 20-character alphanumeric shape; `packages/pyric/test/firestore/oracle-conformance.test.ts` generates 25 sandbox IDs and checks both invariants against that observation.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-adddoc-autoid-format"],
  conformanceTests: ["packages/pyric/test/firestore/oracle-conformance.test.ts"],
  conformanceChecks: [{
    finding: "FS-45",
    observation: "firestore-adddoc-autoid-format",
    expect: { length: 20, isAllAlphanumeric: true },
    probe: "packages/pyric/test/firestore/oracle-conformance.test.ts",
    guards: "Twenty-five independently generated sandbox IDs match production's length and character-set invariants.",
  }],
});
