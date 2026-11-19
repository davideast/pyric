import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ["matches"],
  behavior: "`matches()` as an anchored full-string RE2 match (RULES-B4) in rules — a pattern matching only a substring is `false`",
  status: "conforms",
  evidence: "`oracle:rules-firestore-matches-full-string-regex` — production Firestore Rules Test API verdicts for corpus scenario \"matches-full-string-regex\", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production.",
  oracleObservations: ["rules-firestore-matches-full-string-regex"],
});
