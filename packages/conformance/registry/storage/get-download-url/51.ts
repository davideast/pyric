import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Exported by `firebase/storage`; returns a token-signed HTTPS URL that fetches the blob",
  status: "diverged-documented",
  evidence: "Production observation `storage-upload-bytes-roundtrip` records `urlIsHttps: true` and a byte-identical fetch. The URL form depends on where the sandbox runs. On the Node host, `getDownloadURL` returns `http://<host>/__pyric/storage/v0/b/<bucket>/o/<path>?alt=media&token=<token>`: production's `/v0/b/<bucket>/o/<path>` path and `alt=media` query, under the host's own origin. The token is kept in the object's `downloadTokens` metadata, later calls return the same URL, it does not expire, and removing it from the metadata revokes the URL. A `GET` on the URL needs no header and serves `Range`. The hosted replay of the observation calls `getDownloadURL` and `fetch` through the web client against the host and its byte route, and matches `downloadOk`, `bodyLen`, and `bytesMatch`. The web byte route fixture pins token persistence and revocation, and hosted smoke test 8 streams and seeks an `<audio>` element by the URL in Chromium. In process and in a SharedWorker there is no HTTP origin to serve from, so `getDownloadURL` returns a `data:<contentType>;base64,...` URI that carries the object's bytes. The oracle replay proves its byte-identical fetch and asserts the `data:` prefix, and the client↔host integration proves SharedWorker mode returns the same form. The divergence is URL identity. The hosted URL is `http` on the local host's origin, under `/__pyric/storage`, where production's is `https` on Google Cloud Storage's host, so it is fetchable only where that host is reachable. The `data:` form has no token, no revocation, and no stable short string. Production observation `admin-storage-metadata-download-url` records the token itself: the Firebase metadata endpoint reports it as `downloadTokens`, firebase-admin sees it as the `firebaseStorageDownloadTokens` custom key, removing it makes the URL answer 403, and the URL answers `Range` with 206.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 2 specific value(s)"],
  oracleObservations: ["storage-upload-bytes-roundtrip","admin-storage-metadata-download-url"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/integration.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/cli/test/e2e/hosted/smoke.pw.ts"],
});
