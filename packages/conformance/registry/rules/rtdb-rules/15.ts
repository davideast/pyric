import { row } from './section.ts';

export default row({
  order: 150,
  featureKeys: [],
  behavior: "`.validate` runs on the ancestors of each written path and on every node the written value carries, each against the merged post-write value at its own location; a sibling node the write does not carry is not validated",
  evidence: "`oracle:rules-rtdb-r15-validate-ancestor-scope`: production DENIES a deep write that leaves its validated ancestor without the required child, while the same write under a rule-free ancestor ALLOWS and the write ALLOWS once the ancestor requirement is seeded. `oracle:rules-rtdb-r23-validate-sibling-scope` records production ALLOWING a set of one child, an update of that child alone, a multi-path update of two rooms' children, and a deletion of one child, next to an unchanged sibling whose `.validate` requires a change and a stored sibling that fails its `.validate`, in the same room or another room; ALLOWS a set, an update, and a multi-path update that delete a child an unwritten sibling's `.validate` requires; and DENIES a set of the room or an update that writes those siblings with the value they already hold. The simulator walks validation from the root through each write location and through the written value, never into an unwritten sibling, and matches all 21 captured production cases. `unit:simulation/handler.test.ts` pins the same scope for set, delete, update, and multi-path update. Extended 2026-10-07: `oracle:rules-rtdb-r27-stdlib-core-patterns` deploys the RTDB rules standard library's compiled match, table, note, player and counter rules and records production ALLOWING an update of `guest` and `status` alone next to a step-checked `moveCount` the update does not carry, and an update of `currentTurn` and `moveCount` that steps the count by one, while DENYING an update that steps it by two and a create whose `moveCount` starts past 0. The simulator and the sandbox match production on every standard library case in that capture; `unit:rules/rtdb/stdlib/corpus-lock.test.ts` runs each case through `simulate` and the sandbox and fails when the builders compile to a different ruleset.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-rtdb-r15-validate-ancestor-scope", "rules-rtdb-r23-validate-sibling-scope", "rules-rtdb-r27-stdlib-core-patterns"],
  conformanceTests: [
    "packages/rules/test/rtdb/rules-conformance.test.ts",
    "packages/pyric/test/rules/rtdb/simulation/handler.test.ts",
    "packages/rules/test/rtdb/case-update-query.test.ts",
    "packages/pyric/test/rules/rtdb/simulate-sandbox-agreement.test.ts",
  ],
  constructs: ["rtdb.semantic.validate-non-cascade"],
});
