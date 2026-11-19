import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["Map.get"],
  behavior: "`Map.get(key, default)`, including list-form nested-path traversal (Item 3), in rules",
  status: "conforms",
  evidence: "`oracle:rules-firestore-map-get-string-and-list-form` — production Firestore Rules Test API verdicts for corpus scenario \"map-get-string-and-list-form\", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production.",
  oracleObservations: ["rules-firestore-map-get-string-and-list-form"],
});
