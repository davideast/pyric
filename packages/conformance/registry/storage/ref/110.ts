import { row } from './section.ts';

export default row({
  order: 120,
  api: "ref(storage, 'gs://<bucket>/<path>')",
  behavior: "A `gs://<bucket>/<path>` URL gives the same reference as `ref(storage, '<path>')`, its path not percent-decoded; `gs://<bucket>` gives the root reference, and `gs://` throws `storage/invalid-url`",
  status: "conforms",
  evidence: "Production observation `client-storage-ref-urls` (firebase 12.19.0) records `gsDefaultBucket` and `plainPath` (same `fullPath` and `name`), `gsPathNotDecoded` (`media/take%20one.wav`), `gsBucketRoot` (`fullPath: ''`), and `gsNoBucket` (`storage/invalid-url`). The storage oracle suite replays it against the engine's `ref()`, and `storage-ref-urls.test.ts` against the served page client's `ref()`; both match every case, and a `gs://` URL on the default bucket gives the same bucket as the path alone.",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 3 specific value(s)","asserts Firebase error code(s): `storage/invalid-url`"],
  oracleObservations: ["client-storage-ref-urls"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-ref-urls.test.ts"],
});
