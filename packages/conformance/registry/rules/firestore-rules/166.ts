import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: [],
  behavior: "`request.path`/`request.query`/`resource.id`/`resource.__name__` globals (Item 6) in rules",
  status: "conforms",
  evidence: "`oracle:rules-firestore-globals-request-path-and-resource-id` — production Firestore Rules Test API verdicts for corpus scenario \"globals-request-path-and-resource-id\", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`. `request.query` is now absent on non-list operations, so reading it on create errors to DENY instead of false-ALLOWing through an invented empty map. `request.path` and the create-time absent-resource controls remain unchanged; all 6 cases match production. Resource identity on an EXISTING document is scoped to firestore-rules#183.",
  risk: ["specific-value","rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts rules-denial behavior"],
  oracleObservations: ["rules-firestore-globals-request-path-and-resource-id"],
  constructs: ["firestore.binding.request.query"],
});
