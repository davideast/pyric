import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: "InvalidApiKey / ServiceApiNotEnabled / UnsupportedUserLocation / RETIRED_MODEL 404 / deadline-exceeded 504",
  behavior: "Specializes InvalidApiKey, ServiceApiNotEnabled, and UnsupportedUserLocation from google.rpc.ErrorInfo details or fallback messages and maps retired-model 404 and deadline-exceeded 504 errors.",
  featureKeys: ["InvalidApiKey", "ServiceApiNotEnabled", "UnsupportedUserLocation"],
  status: "conforms",
  evidence: "Verified in `packages/flutter-client/test/ai/ai_error_mapping_parity_test.dart` and `packages/flutter-client/test/live_host/ai_errors_and_app_check_live_host_test.dart` (specializes `google.rpc.ErrorInfo` reason codes and fallback messages across unary and streaming frames and maps `RETIRED_MODEL` 404 and `deadline-exceeded` 504 errors).",
  tests: [
    "packages/flutter-client/test/ai/ai_error_mapping_parity_test.dart",
    "packages/flutter-client/test/live_host/ai_errors_and_app_check_live_host_test.dart",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
