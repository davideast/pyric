import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "ReferencePlatform.getDownloadURL()",
  behavior: "Mints a persistent token-gated download URL serving stored bytes over HTTP without SDK headers and round-tripping through refFromURL.",
  featureKeys: ["getDownloadURL"],
  status: "diverged-documented",
  statusNote: "local byte-route URL",
  evidence: "On the Pyric host, `getDownloadURL()` resolves `http://<host>:<port>/__pyric/storage/v0/b/<bucket>/o/<path>?alt=media&token=<token>` on the local host origin rather than `https://firebasestorage.googleapis.com/...`. Plain HTTP token fetch and `refFromURL` round-tripping are verified in `packages/flutter-client/test/storage/pyric_reference_platform_test.dart` and `packages/flutter-client/test/live_host/storage_live_host_test.dart` (storage-live#4).",
  tests: [
    "packages/flutter-client/test/storage/pyric_reference_platform_test.dart",
    "packages/flutter-client/test/live_host/storage_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
