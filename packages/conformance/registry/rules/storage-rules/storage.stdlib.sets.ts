import { row } from './section.ts';

export default row({
  order: 400,
  featureKeys: ["toSet", "hasAll", "hasAny", "hasOnly", "difference", "union", "intersection", "in"],
  behavior: "`List.toSet()` removes duplicates and Sets compare by value regardless of order. Set `size()`, `hasAll`, `hasAny`, and `hasOnly` take a List or Set argument, and List `hasAll`, `hasAny`, and `hasOnly` take a List argument, where a Set argument is an error. Set `difference`, `union`, and `intersection` take a Set argument, where a List argument is an error, and a List receiver has none of them, which is an error. `in` tests Set membership",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "CONFORMS, 2026-09-24: `oracle:rules-storage-stdlib-sets-and-mapdiff` captures 13 production verdicts for corpus scenario \"stdlib-sets-and-mapdiff\", including the diagnostics `Unsupported operation error. Received: set.difference(list).` and `Function not found error: Name: [difference].` for a List receiver. Sets are the shared Set value. `unit:storage/rules-oracle-conformance.test.ts` replays all 13 verdicts and `unit:storage/sandbox/rules-collection-methods.test.ts` pins membership, algebra, equality, `in`, and the receiver and argument errors. RECAPTURED, 2026-09-28: 27 Set cases, with the same verdicts as the Firestore `set-algebra-difference-union-intersection` capture, show a Set compares elements by numeric value at every depth: `[1].toSet() == [1.0].toSet()`, `[1, 1.0].toSet().size() == 1`, `1 in [1.0].toSet()`, `[1].toSet().hasAll([1.0])`, `[[1]].toSet() == [[1.0]].toSet()` and `[1] in [[1.0]].toSet()` allow, `difference()`, `intersection()` and `union()` treat an int and the equal float as one element, `0.0` and `-0.0` are one element, and two NaN are one element that is in its own Set. The evaluator kept two NaN as two elements; Sets now compare under `setElementsEqual` in `rules/simulator/value-equality.ts`, shared with the Firestore simulator, and the scenario's 46 verdicts all match (`unit:rules/simulator/collection-identity.test.ts`). RECAPTURED, 2026-09-30: 35 set method cases (81 in all) pin the same Set and MapDiff method surface as the Firestore capture: a Set has no `keys()`, `values()`, `get()` or `diff()`, a MapDiff no `keys()`, `values()`, `get()` or `size()`, `size()` takes no argument, the membership methods take one List or Set, the algebra methods one Set, and Set algebra on a List, string or Map is \"Function not found error\". The evaluator reported non-production text for an argument to a Set's `size()`, for `values()` on a Set or MapDiff, and for an algebra argument count; Set methods now dispatch through `setMethod` in `rules/simulator/firestore-set.ts`, shared with the Firestore simulator, and the evaluator matches all 81 verdicts (`unit:storage/rules-oracle-conformance.test.ts`, `unit:rules/simulator/collection-identity.test.ts`).",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-stdlib-sets-and-mapdiff"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-collection-methods.test.ts",
    "packages/rules/test/simulator/collection-identity.test.ts",
  ],
  constructs: ["storage.method.set.hasAll", "storage.method.size", "storage.operator.in", "storage.operator.eq"],
});
