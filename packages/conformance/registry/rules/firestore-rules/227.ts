import { row } from './section.ts';

export default row({
  order: 490,
  featureKeys: ["matches", "split", "replace"],
  behavior: "`matches()` reads `\\p{Cyrillic}`, `\\p{Han}`, `\\p{Latin}` and `\\P{Greek}` as RE2 script classes, inside a class and through a deny-list guard on request data, and a nested repeat `(a+)+b` in `split()` and `replace()` on a 27-character subject returns production's result (FS3-RE2-1)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-script-classes-and-nested-repeats` (found by the 2026-11-03 rules engine defect hunt and captured on 2026-11-04 as `c10-script-classes-and-redos`, 8 cases) records production DENYING a create of the name `Пётр` under `!request.resource.data.name.matches('.*\\\\p{Cyrillic}.*')` (`sg0`) while ALLOWING `Peter`, ALLOWING `'中'.matches('\\\\p{Han}')` (`sg3`), `'a'.matches('[\\\\p{Latin}]')` and `!'α'.matches('\\\\P{Greek}')`, ALLOWING `!'p{Greek}'.matches('\\\\p{Greek}')` (a script class does not match its own name's letters), and ALLOWING the `(a+)+b` `split()` and `replace()` cases. `compileCharMatcher` in `rules/simulator/rules-type.ts` spells RE2's script names as `\\p{Script=Name}` for the matcher (#1889), so pyric agrees on all 8 verdicts; `unit:rules/oracle-conformance.test.ts` replays every verdict with no pin, and `unit:sandbox/rules-re2-script-classes.test.ts` replays them through `setDoc` and `uploadBytes`.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["a guard that refuses a script allows in pyric what production denies, and one that requires a script denies what production allows"],
  oracleObservations: ["rules-firestore-script-classes-and-nested-repeats"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/pyric/test/sandbox/rules-re2-script-classes.test.ts",
  ],
  constructs: ["firestore.method.string.matches"],
});
