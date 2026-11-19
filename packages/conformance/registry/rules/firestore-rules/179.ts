import { row } from './section.ts';

export default row({
  order: 200,
  featureKeys: ["String","List","Map.values"],
  behavior: "`String.split()/lower()/upper()/trim()/replace()/size()`, `List.hasAll()/hasAny()/hasOnly()/join()`, and `Map.values()` in rules",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-12: production capture proves the simulator matches the production Firestore Rules Test API verdict-for-verdict on all 4 cases (CSV-split membership, slug/title/code normalization). `oracle:rules-firestore-list-and-string-methods` — replayed by `unit:rules/oracle-conformance.test.ts`.",
  oracleObservations: ["rules-firestore-list-and-string-methods"],
});
