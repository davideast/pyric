import { row } from './section.ts';

export default row({
  order: 20,
  status: "conforms",
  automation: "oracle-backed",
  behavior: "`snap.exists` is normalized to method form (`snap.exists()` returns boolean) to match the modular SDK",
  evidence: "`playground:firestore-onsnapshot` (bundled, assertion-shape compat) + `playground:firestore-row-17-snap-exists-method` (one-claim) + `oracle:firestore-getdoc-snapshot-shape-missing-and-ref`",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  oracleObservations: ["firestore-getdoc-snapshot-shape-missing-and-ref"],
  conformanceTests: ["packages/pyric/test/firestore/oracle-captures/firestore-getdoc-getdocs.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-getdoc-getdocs.test.ts"],
});
