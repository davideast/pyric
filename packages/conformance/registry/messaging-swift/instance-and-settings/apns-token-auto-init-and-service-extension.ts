import { row } from './section.ts';

export default row({
  order: 30,
  api: "apnsToken / setAPNSToken(_:type:) / isAutoInitEnabled / useEmulator(withHost:port:sslEnabled:) / Messaging.serviceExtension()",
  behavior: "Stores raw APNs device tokens and MessagingAPNSTokenType metadata locally, toggles isAutoInitEnabled and per-Messaging emulator overrides, and processes notification mutable content via MessagingExtensionHelper.",
  featureKeys: ["Messaging.apnsToken", "Messaging.setAPNSToken", "Messaging.isAutoInitEnabled", "Messaging.useEmulator", "Messaging.serviceExtension", "MessagingExtensionHelper"],
  evidence: "Verified in `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift` (`Supports multi-sender tokens, deleteData(), APNs token types, completion handlers, and FID mode`).",
  tests: [
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift",
  ],
});
