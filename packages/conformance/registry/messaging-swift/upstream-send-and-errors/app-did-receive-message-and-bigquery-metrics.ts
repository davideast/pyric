import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: "appDidReceiveMessage(_:) / setDeliveryMetricsExportToBigQuery(_:) / exportedDeliveryMetrics",
  behavior: "Extracts google.c.a.c_id, gcm.message_id, and APNs userInfo metadata into MessagingMessageInfo and appends BigQuery delivery export records whenever isDeliveryMetricsExportToBigQueryEnabled is true.",
  featureKeys: ["Messaging.appDidReceiveMessage", "Messaging.setDeliveryMetricsExportToBigQuery", "MessagingMessageInfo"],
  status: "conforms",
  evidence: "Verified in `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift` and `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift`.",
  tests: [
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift",
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingLiveHostTests.swift",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
