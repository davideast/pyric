import { row } from './section.ts';

export default row({
  order: 30,
  api: "InvalidApiKey / ServiceApiNotEnabled / UnsupportedUserLocation / RETIRED_MODEL 404 / deadline-exceeded 504",
  behavior: "Specializes InvalidApiKey, ServiceApiNotEnabled, and UnsupportedUserLocation from google.rpc.ErrorInfo details or fallback messages and maps retired-model 404 and deadline-exceeded 504 errors.",
  featureKeys: ["InvalidApiKey", "ServiceApiNotEnabled", "UnsupportedUserLocation"],
  evidence: "Verified in `packages/flutter-client/test/ai/ai_error_mapping_parity_test.dart`.",
  tests: [
    "packages/flutter-client/test/ai/ai_error_mapping_parity_test.dart",
  ],
});
