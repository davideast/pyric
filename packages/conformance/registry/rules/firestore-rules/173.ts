import { row } from './section.ts';

export default row({
  order: 140,
  featureKeys: [],
  behavior: "Range-slice `[i:j]` syntax for `List` and `String` (Item 4) in rules",
  status: "conforms",
  evidence: "`oracle:rules-firestore-range-slice-list-and-string` — production Firestore Rules Test API verdicts for all ten corpus cases in \"range-slice-list-and-string\", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`, including out-of-bounds slice-end rejection for both lists and strings. RECAPTURED, 2026-09-27: 13 bounds cases (23 in all) show production checks, in order, that `start` is an index, that `end - 1` is an index, and that `start` does not exceed `end`. `[0:0]`, `[n:n]`, `[1:0]`, and a slice of an empty list or string are `Index out of bound error. Index: [i] , size: [n].`, a start after the end is `Illegal range error. From index: [i] , To index: [j].`, and `[i:i]` for 0 < i < n is empty. The simulator evaluated `[0:0]`, `[n:n]`, a start after the end, and empty-value slices as empty values; it now raises the same errors and matches all 23 verdicts.",
  risk: ["specific-value","rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts rules-denial behavior"],
  oracleObservations: ["rules-firestore-range-slice-list-and-string"],
  constructs: ["firestore.operator.slice"],
});
