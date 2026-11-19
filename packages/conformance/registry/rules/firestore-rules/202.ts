import { row } from './section.ts';

export default row({
  order: 400,
  featureKeys: ["split", "trim"],
  behavior: "`split()` drops trailing empty pieces, and `trim()` strips only code units at or below U+0020, keeping NBSP, U+3000 and the byte-order mark (FS2-SIM-7, FS2-SIM-8)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-split-and-trim-edges` (captured 2026-10-27, recaptured 2026-10-28 with 7 more cases, 18 in all, every earlier verdict unchanged) records production ALLOWING `'a,b,'.split(',') == ['a', 'b']`, `'a,b,,'.split(',').size() == 2`, `',a,'.split(',') == ['', 'a']` and `'a1b2'.split('([0-9])') == ['a', 'b']`, ALLOWING `'a.b.c'.split('.') == ['']`, `','.split(',') == ['']` and `',,'.split(',') == ['']` while DENYING `','.split(',').size() == 0` and `'a.b.c'.split('.').size() == 0` (trailing empty pieces are dropped, but one piece always remains), DENYING `'a,b,'.split(',') == ['a', 'b', '']`, and ALLOWING `trim keeps NBSP`, `trim keeps ideographic space`, `trim keeps BOM` and `trim strips C0 controls`. `unit:rules/oracle-conformance.test.ts` replays all 18 cases against the local simulator. `split()` goes through the shared `splitRe2` (#1333), which Storage also calls, and `unit:rules/simulator/split-and-replace.test.ts` replays the split cases from this observation on Firestore and Storage. `trim()` strips code units at or below U+0020 through the shared `trimRulesString` (#1295), and `unit:rules/simulator/re2-space-and-trim.test.ts` replays the 4 FS2-SIM-8 cases.",
  oracleObservations: ["rules-firestore-split-and-trim-edges"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/simulator/re2-space-and-trim.test.ts",
    "packages/rules/test/simulator/split-and-replace.test.ts",
  ],
  constructs: ["firestore.method.string.split"],
});
