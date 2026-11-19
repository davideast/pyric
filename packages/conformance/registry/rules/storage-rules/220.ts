import { row } from './section.ts';

export default row({
  order: 580,
  featureKeys: ["lower", "upper"],
  behavior: "`lower()` and `upper()` map the ASCII letters only and leave every other letter as it is (ST3-D-1)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-st3-case-mapping-ascii` (captured 2026-11-04 by the Storage rules engine defect hunt, 12 cases) records production ALLOWING `'é'.upper() == 'é'`, `'Ä'.lower() == 'Ä'`, `'ΑΣ'.lower() == 'ΑΣ'`, `'ж'.upper() == 'ж'`, `'İ'.lower() == 'İ'`, `'ı'.upper() == 'ı'` and `'aé'.upper() == 'Aé'`, and DENYING `'é'.upper() == 'É'`, `'Ä'.lower() == 'ä'`, `'ж'.upper() == 'Ж'`, `'ａ'.upper() == 'Ａ'` and `'ÉVE@X.COM'.lower() == 'éve@x.com'`. `oracle:rules-storage-st3-case-mapping` (same hunt, 13 cases) records production ALLOWING `'aB'.upper() == 'AB'`, `'ß'.upper() == 'ß'`, `'ß'.upper().size() == 1`, `'ﬁ'.upper() == 'ﬁ'`, `'İ'.lower().size() == 1` and `'և'.upper().size() == 1`, and DENYING `'ΑΣ'.lower() == 'ασ'`, `'İ'.lower() == 'i'`, `'ı'.upper() == 'I'`, `'ſ'.upper() == 'S'`, `'ǅ'.upper() == 'Ǆ'` and `'ß'.upper() == 'ẞ'`. Storage's `lower()` and `upper()` call the shared `lowerRulesString` and `upperRulesString` in `rules/simulator/string-case.ts` (#1885), so the evaluator agrees on all 24 case-mapping verdicts; before, it mapped every Unicode letter and 20 differed. The capture's last case, a one-key `{path}` map from a `firestore.get()` function mock, is ST3-D-3 and stays pinned in `packages/conformance/storage-rules-exceptions/`. `unit:storage/rules-oracle-conformance.test.ts` replays all 25 verdicts and `unit:storage/sandbox/rules-ascii-case.test.ts` runs the case-mapping cases through `uploadBytes`.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["a rule that case-folds user text with a non-ASCII letter, such as an email or a file name, compares a different value from production's"],
  oracleObservations: ["rules-storage-st3-case-mapping", "rules-storage-st3-case-mapping-ascii"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/pyric/test/storage/sandbox/rules-ascii-case.test.ts",
  ],
  constructs: ["storage.method.string.lower", "storage.method.string.upper"],
});
