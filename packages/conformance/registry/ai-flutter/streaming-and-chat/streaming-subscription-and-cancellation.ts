import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "GenerativeModel.generateContentStream(...) / Stream<GenerateContentResponse>",
  behavior: "Streams ordered GenerateContentResponse chunks over worker-sub and sends worker-unsub on StreamSubscription.cancel() without disturbing concurrent streams on the same bridge.",
  featureKeys: ["GenerativeModel.generateContentStream"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/ai/ai_streaming_test.dart`, `packages/flutter-client/test/ai/ai_concurrent_streams_test.dart`, and `packages/flutter-client/test/live_host/ai_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/ai/ai_streaming_test.dart",
    "packages/flutter-client/test/ai/ai_concurrent_streams_test.dart",
    "packages/flutter-client/test/live_host/ai_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
