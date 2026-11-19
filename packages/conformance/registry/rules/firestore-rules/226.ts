import { row } from './section.ts';

export default row({
  order: 480,
  featureKeys: ["toSet", "in", "hasAll", "hasAny", "removeAll"],
  behavior: "An int and a float in collections: one value under `==`, distinct elements in a List or Map, one element in a Set, and distinct Set elements past 2^53",
  status: "conforms",
  evidence: "`oracle:rules-firestore-mixed-number-collections` (captured 2026-11-04 by the rules engine defect hunt as `c3-mixed-number-collections`, 17 cases) records production ALLOWING `1 == 1.0`, `9007199254740993 == 9007199254740992.0` and `[1.0].toSet().hasOnly([1])`, and DENYING `[1] == [1.0]`, `1 in [1.0]`, `[1].hasAll([1.0])`, `[1.0].hasAny([1])`, `removeAll()` across the two types, nested Lists and Maps of them, and `[9007199254740993].toSet() == [9007199254740992.0].toSet()` (`b6`). The simulator compared an int and a float past 2^53 through a double in a Set, so `b6` allowed (#1893); `setElementsEqual` now compares an int against a float's exact value, and `unit:rules/oracle-conformance.test.ts` replays all 17 verdicts with no pin (`unit:sandbox/rules-int-float-sets.test.ts`).",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts that Set equality keeps an int and a float past 2^53 apart"],
  oracleObservations: ["rules-firestore-mixed-number-collections"],
  constructs: ["firestore.method.list.toSet"],
});
