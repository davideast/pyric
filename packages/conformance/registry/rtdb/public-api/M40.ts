import { row } from './section.ts';

export default row({
  order: 570,
  featureKeys: ["ref"],
  behavior: "`DatabaseReference` carries a stable `key` (`null` at root, last path segment elsewhere) and `toString()` returning `Repo.toString()` origin plus URL-encoded path segments (`https://<instance>.firebaseio.com/<path>`)",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-reference-shape-url` captures root and nested `key`, `parent`, `root`, and HTTPS URL formatting; `unit:modular/oracle-conformance-reference-writes.test.ts` and `packages/cli/test/serve/worker/oracle-captures/rtdb-reference-shape-url.test.ts` replay across in-process, SharedWorker, and Node host planes.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-reference-shape-url"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-reference-shape-url.test.ts"],
  rowNumber: 40,
});
