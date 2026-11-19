import { row } from './section.ts';

export default row({
  order: 150,
  api: "ref(storage, '<origin>/__pyric/storage/v0/b/<bucket>/o/<path>')",
  behavior: "Production throws `storage/invalid-url` for a URL on the Node host's `/__pyric/storage/v0/` route, as for any host it does not serve from. The sandbox reads the percent-decoded object path from `<origin>/__pyric/storage/v0/b/<bucket>/o/<path>` on any origin, as production does from its own download URL",
  status: "diverged-documented",
  evidence: "Production observation `client-storage-ref-urls` (firebase 12.19.0) records `pyricHostUrl` (`storage/invalid-url`). The Node host's `getDownloadURL` issues this form, so an app that keeps a download URL and later calls `deleteObject(ref(storage, url))` needs `ref()` to read it. The storage oracle suite replays it against the engine's `ref()`, and `storage-ref-urls.test.ts` against the served page client's `ref()`: both pin production's code beside the sandbox's reference, whose `fullPath` and `name` equal those production gives for `firebaseDownloadUrl`. The web byte route fixture in `hosted-sqlite.test.ts` keeps a download URL from the Node host and deletes the object by `ref(storage, url)`, and hosted smoke test 9 does the same from a Chromium page against the built CLI's Node host. Production never issues this URL, so no production app depends on the error.",
  risk: ["error-code"],
  riskReasons: ["asserts Firebase error code(s): `storage/invalid-url`"],
  oracleObservations: ["client-storage-ref-urls"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-ref-urls.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts"],
  conformanceDisposition: "by-design",
});
