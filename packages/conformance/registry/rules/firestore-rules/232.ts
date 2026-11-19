import { row } from './section.ts';

export default row({
  order: 540,
  featureKeys: ["split", "replace"],
  behavior: "`replace()` and `split()` read RE2's scoped and inline flags, `(?U)`, `\\pL`, `[[:alpha:]]`, `\\Q..\\E`, an astral character as one code point, and `\\z` and `\\A` under `(?m)` as production does, and `replace()` fills `$n` and `${name}` from RE2's capture groups (FS3-RE2-2, FS3-RE2-3, FS3-RE2-4, known #1332 flags)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-re2-replace-and-split-dialect` (captured 2026-11-04 by the rules engine defect hunt as `c1-re2-replace-split`, 32 cases) records production's verdict on each, and the simulator agrees on all 32. The 4 `split()` cases agree since `split()` moved onto the linear matcher `matches()` uses and reads code points (#1895, #1890): `'Ab'.split('a(?i:b)') == ['Ab']` (`sf4`), `'1a2'.split('\\\\pL') == ['1', '2']` (`pl2`), `'a😀b'.split('[^ab]') == ['a', 'b']` (`as2`), and `'a😀b'.split('').size() == 3` DENIED (`as7`). The 23 `replace()` cases agree since `replaceRe2` in `rules/simulator/rules-type.ts` searches with the same matcher and reads capture groups from it: scoped and inline flags (`sf0` to `sf6`, #1332), `(?U)` (`ug0`, `ug1`, #1891), `\\\\p{L}`, `\\\\pL`, `[[:alpha:]]` and `\\\\Q..\\\\E` (`pl0`, `pl1`, `px0`, `qe0`, `qe1`, #2211), an emoji as one code point (`as0`, `as1`, `as3`, #1890), `\\\\z` and `\\\\A` under `(?m)` (`za0`, `za1`, #1892), empty matches (`em0` to `em2`: `'abc'.replace('b*', '-') == '-a--c-'`) and replacement templates (`tp0` to `tp2`). The `matches()` and `size()` twins agree. `unit:rules/oracle-conformance.test.ts` replays every verdict with no pin; `unit:rules/simulator/replace-linear-re2.test.ts` replays each `replace()` case through a sandbox `setDoc` against this observation, and `unit:rules/simulator/split-linear-re2.test.ts` the `split()` cases.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["a rule that rewrites or splits user text with an RE2 flag, class, quote, emoji or absolute anchor compares a different value from production's"],
  oracleObservations: ["rules-firestore-re2-replace-and-split-dialect"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/pyric/test/rules/simulator/split-linear-re2.test.ts",
    "packages/pyric/test/rules/simulator/replace-linear-re2.test.ts",
  ],
  constructs: ["firestore.method.string.split", "firestore.method.string.replace"],
});
