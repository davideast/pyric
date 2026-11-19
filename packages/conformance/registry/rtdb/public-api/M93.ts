import { row } from './section.ts';

export default row({
  order: 1060,
  featureKeys: ["ref","query"],
  behavior: "`DatabaseReference` and `Query` equality includes database target, path, and canonical query parameters, and `toJSON()` serializes the HTTPS database URL (`toString()`).",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-reference-shape-url` captures `isEqual` and HTTPS `toJSON()` across `DatabaseReference` and `Query`; `unit:modular/oracle-conformance-reference-writes.test.ts` and `packages/cli/test/serve/worker/oracle-captures/rtdb-reference-shape-url.test.ts` replay across in-process, SharedWorker, and Node host planes.",
  risk: ["specific-value","structural"],
  riskScore: 2,
  riskReasons: ["asserts query/reference identity semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-reference-shape-url"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-reference-shape-url.test.ts"],
  rowNumber: 93,
});
