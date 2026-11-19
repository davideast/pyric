import { row } from './section.ts';

export default row({
  order: 130,
  api: "ref(storage, downloadUrl)",
  behavior: "A download URL, `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>` or `https://storage.googleapis.com/<bucket>/<path>`, gives the reference at the percent-decoded path; the query, such as `alt` and `token`, is ignored, and a URL with no object path throws `storage/invalid-url`",
  status: "conforms",
  evidence: "Production observation `client-storage-ref-urls` (firebase 12.19.0) records `firebaseDownloadUrl` (`media/take.wav`), `firebaseDownloadUrlEncoded` (`my media/take 1.wav`), `cloudStorageUrl` (`media/take.wav`), and `firebaseUrlNoObject` (`storage/invalid-url`). The storage oracle suite replays it against the engine's `ref()`, and `storage-ref-urls.test.ts` against the served page client's `ref()`; both match every case.",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 3 specific value(s)","asserts Firebase error code(s): `storage/invalid-url`"],
  oracleObservations: ["client-storage-ref-urls"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-ref-urls.test.ts"],
});
