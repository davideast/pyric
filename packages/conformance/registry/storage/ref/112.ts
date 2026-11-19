import { row } from './section.ts';

export default row({
  order: 140,
  api: "ref(storage, url)",
  behavior: "A URL on a host other than Firebase Storage's or Cloud Storage's throws `storage/invalid-url`",
  status: "conforms",
  evidence: "Production observation `client-storage-ref-urls` (firebase 12.19.0) records `otherHostUrl` (`storage/invalid-url`). The storage oracle suite replays it against the engine's `ref()`, and `storage-ref-urls.test.ts` against the served page client's `ref()`; both throw `storage/invalid-url`.",
  risk: ["error-code"],
  riskScore: 3,
  riskReasons: ["asserts Firebase error code(s): `storage/invalid-url`"],
  oracleObservations: ["client-storage-ref-urls"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-ref-urls.test.ts"],
});
