import { row } from './section.ts';

export default row({
  order: 530,
  featureKeys: ["service"],
  behavior: "A rules file with a `service firebase.storage` block before its `service cloud.firestore` block compiles, and the Firestore block decides; two `cloud.firestore` blocks are refused with \"Duplicate service name declaration.\" (FS3-VAL-4)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-two-services-storage-first` (found by the 2026-11-03 rules engine defect hunt and captured on 2026-11-04 as `c5a-two-services-storage-first`, 1 case) records production compiling the file and DENYING get `c/1`, which only the Firestore block's `allow get: if false` decides. The same capture's `c5b-two-firestore-services` records production refusing two `cloud.firestore` blocks with \"Duplicate service name declaration.\". The grammar took one service block, so pyric refused c5a at load (#1900); `RulesFile` now takes `ServiceBlock+`, the parser reads the `cloud.firestore` block as the ruleset's service, and `checkRulesSource` refuses a second block for one service with production's reason. `unit:rules/oracle-conformance.test.ts` replays the verdict with no pin, and `unit:sandbox/rules-multiple-services.test.ts` checks both captures through `setRules` and `firestoreRules()`.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["pyric refused at load a ruleset production deploys"],
  oracleObservations: ["rules-firestore-two-services-storage-first"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/pyric/test/sandbox/rules-multiple-services.test.ts",
  ],
});
