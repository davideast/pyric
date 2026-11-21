import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "Candidate.finishReason (SAFETY, RECITATION) / FirebaseAIException / QuotaExceeded / ServerException",
  behavior: "Surfaces FinishReason.safety and FinishReason.recitation blocked candidates (response.text == null) and maps 400 invalid-argument, 401 unauthenticated, 403 permission-denied, 429 quota-exceeded (QuotaExceeded), and 503 unavailable (ServerException) wire errors.",
  featureKeys: ["FirebaseAIException", "QuotaExceeded", "ServerException", "FinishReason"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/ai/ai_error_mapping_parity_test.dart` and `packages/flutter-client/test/live_host/ai_live_host_test.dart`.",
  tests: [
    "packages/flutter-client/test/ai/ai_error_mapping_parity_test.dart",
    "packages/flutter-client/test/live_host/ai_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
