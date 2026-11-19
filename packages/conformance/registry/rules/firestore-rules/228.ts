import { row } from './section.ts';

export default row({
  order: 500,
  featureKeys: ["matches", "split", "replace"],
  behavior: "`matches()`, `split()` and `replace()` read RE2's Unicode classes (`\\pN`, `\\p{Greek}`), POSIX classes, `\\Q..\\E`, `(?i)`, `\\x61`, `\\b`, `\\d`, `.` against U+2028 and a class range over emoji as production does (FS3-RE2-1, FS3-RE2-2)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-re2-more-classes-and-escapes` (captured 2026-11-04 by the rules engine defect hunt as `c9-re2-more`, 15 cases) records production ALLOWING every case: `'α'.matches('\\\\p{Greek}')` (`pg1`), `'😀'.replace('[😀-😂]', 'x') == 'x'` (`ar0`) and `'a😀'.split('[😀-😂]') == ['a']` (`ar1`), `'a1'.replace('\\\\pN', 'x') == 'ax'` (`pn0`), `'α'.replace('\\\\p{Greek}', 'x') == 'x'` (`pg0`), `'a.b'.split('[[:punct:]]') == ['a', 'b']` (`px2`), `'a.b'.split('\\\\Q.\\\\E') == ['a', 'b']` (`qs0`), and the `(?i)`, `[[:^alpha:]]`, U+2028, `\\\\x61`, `\\\\b` and `\\\\d` cases. The simulator agrees on all 15. In `matches()`, `compileCharMatcher` in `rules/simulator/rules-type.ts` spells RE2's script names for the `u` flag, so `pg1` agrees (#1889). `split()` and `replace()` run on the linear matcher `matches()` uses and read code points, so `ar1` and `ar0` agree (#1890), and `replace()` reads `\\\\pN` and `\\\\p{Greek}` as classes (`pn0`, `pg0`, #2211). `parseRe2Pattern` reads `[[:punct:]]` as RE2's ASCII POSIX class and `\\\\Q..\\\\E` as literal text, so `px2` and `qs0` agree (#2211). `unit:rules/oracle-conformance.test.ts` replays every verdict with no pin, and `unit:rules/simulator/split-linear-re2.test.ts` replays `ar1` through a sandbox `setDoc`.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["a rule that matches, splits or normalizes user text with an RE2 class or an emoji range compares a different value from production's"],
  oracleObservations: ["rules-firestore-re2-more-classes-and-escapes"],
  constructs: ["firestore.method.string.matches", "firestore.method.string.split", "firestore.method.string.replace"],
});
