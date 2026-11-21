import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: "StorageReference.getDownloadUrl()",
  behavior: "Mints a persistent token-gated download URI that serves stored object bytes over plain HTTP without SDK headers and round-trips through getReferenceFromUrl.",
  featureKeys: ["StorageReference.getDownloadUrl"],
  status: "diverged-documented",
  statusNote: "local byte-route URL",
  evidence: "On the Pyric host, `getDownloadUrl()` returns `http://<host>:<port>/__pyric/storage/v0/b/<bucket>/o/<path>?alt=media&token=<token>` on the local host origin rather than `https://firebasestorage.googleapis.com/...`. Direct unauthenticated HTTP GET with the minted token and `getReferenceFromUrl` round-tripping are verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageCoreOperationsTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt` (getDownloadUrlMintsTokenizedHttpUrlAndRoundTripsGetReferenceFromUrl).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/StorageCoreOperationsTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
