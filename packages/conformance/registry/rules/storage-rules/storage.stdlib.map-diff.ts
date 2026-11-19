import { row } from './section.ts';

export default row({
  order: 410,
  featureKeys: ["diff", "addedKeys", "removedKeys", "changedKeys", "unchangedKeys", "affectedKeys"],
  behavior: "`Map.diff(other)` over custom metadata returns a MapDiff whose `addedKeys()`, `removedKeys()`, `changedKeys()`, `unchangedKeys()`, and `affectedKeys()` are Sets of own keys, including keys named `constructor` and `toString`, so an `affectedKeys().hasOnly([...])` guard allows a change to the listed keys and denies any other",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "CONFORMS, 2026-09-24: `oracle:rules-storage-stdlib-sets-and-mapdiff` pins all five accessors on one metadata update, the label-only guard ALLOW and owner-change DENY, `in` over `changedKeys()`, and a diff that adds `constructor` and removes `toString`. The discovery capture stdlib-storage-p2-native-advanced recorded the same affected/added/removed guard verdicts earlier. The shared MapDiff reads own keys only. `unit:storage/rules-oracle-conformance.test.ts` replays the verdicts and `unit:storage/sandbox/rules-collection-methods.test.ts` pins the accessors and own-key diffs. RECAPTURED, 2026-09-28: 6 `diff()` cases show a diff compares values by numeric value at every depth, as Firestore's does: an int and the equal float, an int List and the equal float List, `0.0` and `-0.0`, and two NaN are unchanged, and an int beside a different float is changed. The shared MapDiff reported two NaN as changed; it now compares under `setElementsEqual` in `rules/simulator/value-equality.ts` and matches all six (`unit:rules/simulator/collection-identity.test.ts`).",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-stdlib-sets-and-mapdiff"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-collection-methods.test.ts",
  ],
  constructs: ["storage.binding.request.resource.metadata", "storage.binding.resource.metadata"],
});
