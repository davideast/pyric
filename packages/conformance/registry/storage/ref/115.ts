import { row } from './section.ts';

export default row({
  order: 170,
  api: "ref(storage, 'data:...')",
  behavior: "Production reads a string without `://`, such as a `data:` URI, as an object path. The sandbox throws `storage/invalid-url` for a `data:` URI",
  status: "diverged-documented",
  evidence: "Production observation `client-storage-ref-urls` (firebase 12.19.0) records `dataUri` (`fullPath: 'data:audio/wav;base64,UklGRg=='`, `name: 'wav;base64,UklGRg=='`). In process and on a SharedWorker host, `getDownloadURL` returns a `data:` URI (storage#51), and no object exists at that literal path, so reading it as a path would make `deleteObject(ref(storage, url))` resolve and delete nothing. The storage oracle suite replays it against the engine's `ref()`, and `storage-ref-urls.test.ts` against the served page client's `ref()`: both pin production's path beside the sandbox's `storage/invalid-url`, and the storage oracle suite shows a reference to a `data:` download URL throws while the object stays.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  oracleObservations: ["client-storage-ref-urls"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-ref-urls.test.ts"],
  conformanceDisposition: "by-design",
});
