import { row } from './section.ts';

export default row({
  order: 510,
  featureKeys: ["lower", "upper"],
  behavior: "`lower()` and `upper()` map the ASCII letters only and leave every other letter as it is (FS3-STR-1)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-string-case-mapping` (captured 2026-11-04 by the rules engine defect hunt as `c11-case-mapping`, 17 cases) records production ALLOWING `'aB'.upper() == 'AB'` (`cm0`), `'é'.upper() == 'é'` (`cm2`), `'Ä'.lower() == 'Ä'` (`cm4`), `'ΑΣ'.lower() == 'ΑΣ'` (`cm6`), `'ж'.upper() == 'ж'` (`cm8`), `'aé'.upper() == 'Aé'` (`cm9`), `'ÉVE@X.COM'.lower() == 'Éve@x.com'` (`cmb`) and `'ß'.upper() == 'ß'` (`cmd`), and DENYING the full Unicode answers: `'é'.upper() == 'É'`, `'Ä'.lower() == 'ä'`, `'ΑΣ'.lower() == 'ασ'`, `'ж'.upper() == 'Ж'`, `'ÉVE@X.COM'.lower() == 'éve@x.com'` (`cma`), `'ß'.upper() == 'SS'`, `'İ'.lower().size() == 2`, `'ａ'.upper() == 'Ａ'`, and a create whose `request.resource.data.email` is `ÉVE@X.COM` against `email.lower() == 'éve@x.com'` (`cmg`). The simulator mapped every Unicode letter with JavaScript's case mapping, so 15 cases differed (#1896); `rules/simulator/string-case.ts` now maps the ASCII letters only, and `unit:rules/oracle-conformance.test.ts` replays all 17 verdicts with no pin (`unit:sandbox/rules-ascii-case.test.ts` through `setDoc`).",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["a rule that case-folds user text with a non-ASCII letter, such as an email or a handle, compares a different value from production's"],
  oracleObservations: ["rules-firestore-string-case-mapping"],
  constructs: ["firestore.method.string.lower", "firestore.method.string.upper"],
});
