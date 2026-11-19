import { row } from './section.ts';

export default row({
  order: 520,
  featureKeys: ["matches"],
  behavior: "`matches()` compiles a class range over characters outside the Basic Multilingual Plane, such as `[😀-😂]`, and matches it by code point (FS3-VAL-5)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-astral-range-matches` (found by the 2026-11-03 rules engine defect hunt and captured on 2026-11-04 as `c9b-astral-range-matches`, 1 case) records production compiling `'😀'.matches('[😀-😂]')` and ALLOWING get `ar2/1` (`ar2`). `re2PatternProblem` in `rules/simulator/re2-pattern-check.ts` accepts a pattern that compiles as code points when it does not compile as code units (#1901), so pyric loads the ruleset and agrees; `unit:rules/oracle-conformance.test.ts` replays the verdict with no pin, and `unit:sandbox/rules-re2-script-classes.test.ts` replays it through `setDoc` and `uploadBytes`.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["pyric refused at load a ruleset production deploys"],
  oracleObservations: ["rules-firestore-astral-range-matches"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/pyric/test/sandbox/rules-re2-script-classes.test.ts",
  ],
  constructs: ["firestore.method.string.matches"],
});
