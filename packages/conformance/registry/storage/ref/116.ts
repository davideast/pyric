import { row } from './section.ts';

export default row({
  order: 180,
  api: "ref(reference, url)",
  behavior: "Only a Storage instance takes a URL: `ref(reference, url)` throws `storage/invalid-argument`",
  status: "conforms",
  evidence: "Production observation `client-storage-ref-urls` (firebase 12.19.0) records `childRefWithUrl` (`storage/invalid-argument`). The storage oracle suite replays it against the engine's `ref()`, and `storage-ref-urls.test.ts` against the served page client's `ref()`; both throw `storage/invalid-argument`.",
  risk: ["error-code"],
  riskReasons: ["asserts Firebase error code(s): `storage/invalid-argument`"],
  oracleObservations: ["client-storage-ref-urls"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-ref-urls.test.ts"],
});
