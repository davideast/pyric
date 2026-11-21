import { row } from './section.ts';

export default row({
  order: 40,
  api: "token(completion:) / deleteToken(completion:) / deleteData() / register() / unregister() / isInstallationIdEnabled",
  behavior: "Supports callback completion-handler overloads for token and topic operations, full local-and-broker state reset via deleteData(), explicit register()/unregister() calls, and synthetic Firebase Installation ID attachment when isInstallationIdEnabled is enabled.",
  featureKeys: ["Messaging.deleteData", "Messaging.register", "Messaging.unregister", "Messaging.isInstallationIdEnabled"],
  evidence: "Verified in `packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift` (`Supports multi-sender tokens, deleteData(), APNs token types, completion handlers, and FID mode`).",
  tests: [
    "packages/swift-client/Tests/PyricMessagingTests/PyricMessagingUnitTests.swift",
  ],
});
