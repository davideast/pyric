import Foundation
import Testing
import PyricFirestore
import PyricMessaging

private final class LiveTokenDelegate: MessagingDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String] = []

    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        _ = messaging
        guard let fcmToken else { return }
        lock.lock()
        tokens.append(fcmToken)
        lock.unlock()
    }

    func snapshot() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return tokens
    }
}

@Suite("PyricMessaging Live-Host Conformance Suite", .serialized)
struct PyricMessagingLiveHostTests {
    private static func trimmedEnv(_ key: String) -> String? {
        guard let raw = ProcessInfo.processInfo.environment[key]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            return nil
        }
        return raw
    }

    @Test("Executes token lifecycle, topic and condition fanout, visibility routing, acknowledgments, and multi-app isolation over live MessagingBroker")
    func fullLiveHostMessagingWorkflow() async throws {
        guard let rawBridgeURL = Self.trimmedEnv("PYRIC_LIVE_MESSAGING_BRIDGE_URL") else {
            // Standalone offline `swift test` fallback: verify local topic validation and
            // APNs/appDidReceiveMessage behavior on a UUID-scoped named FirebaseApp without network I/O.
            let offlineApp = FirebaseApp(
                name: "offline-swift-msg-\(UUID().uuidString)",
                options: FirebaseOptions(projectID: "demo-offline-swift-messaging"),
                environment: [:]
            )
            let offlineMessaging = Messaging.messaging(app: offlineApp)
            do {
                try await offlineMessaging.subscribe(toTopic: "invalid/topic")
                Issue.record("Expected invalidTopicName for slash-containing topic")
            } catch let err as MessagingError {
                #expect(err.code == .invalidTopicName)
            }
            let info = offlineMessaging.appDidReceiveMessage(["gcm.message_id": "offline-1"])
            #expect(info.status == .new)
            await Messaging.evictInstance(for: offlineApp)
            await offlineApp.delete()
            return
        }

        let projectID = Self.trimmedEnv("PYRIC_LIVE_PROJECT_ID") ?? "demo-swift-messaging-live"
        let iosAppID = Self.trimmedEnv("PYRIC_LIVE_IOS_APP_ID") ?? "1:999999999999:ios:swiftmessagingclient"
        let bridgeURI = try #require(URL(string: rawBridgeURL))
        let bridgeHost = try #require(bridgeURI.host)
        let bridgePort = try #require(bridgeURI.port)

        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            let options = FirebaseOptions(
                projectID: projectID,
                apiKey: "sandbox-messaging-key",
                googleAppID: iosAppID
            )
            let appAName = "live-swift-msg-a-\(UUID().uuidString)"
            let appBName = "live-swift-msg-b-\(UUID().uuidString)"
            FirebaseApp.configure(name: appAName, options: options)
            FirebaseApp.configure(name: appBName, options: options)
            let appA = try #require(FirebaseApp.app(name: appAName))
            let appB = try #require(FirebaseApp.app(name: appBName))
            appA.useEmulator(withHost: bridgeHost, port: bridgePort)
            appB.useEmulator(withHost: bridgeHost, port: bridgePort)

            let messagingA = Messaging.messaging(app: appA)
            let messagingB = Messaging.messaging(app: appB)
            let delegateA = LiveTokenDelegate()
            messagingA.delegate = delegateA

            var fgIterA = messagingA.foregroundMessages.makeAsyncIterator()
            var bgIterA = messagingA.backgroundMessages.makeAsyncIterator()
            var bgIterB = messagingB.backgroundMessages.makeAsyncIterator()

            // 1. Mint stable 142-char `:APA91b` tokens with distinct per-app registrations
            let tokenA1 = try await messagingA.token()
            let tokenA2 = try await messagingA.token()
            let tokenB = try await messagingB.token()
            #expect(tokenA1.count == 142)
            #expect(tokenA1.contains(":APA91b"))
            #expect(tokenA1 == tokenA2)
            #expect(tokenA1 != tokenB)
            #expect(messagingA.fcmToken == tokenA1)
            #expect(delegateA.snapshot() == [tokenA1])

            // Multi-sender token retrieval & deletion without clobbering default fcmToken
            let senderToken = try await messagingA.retrieveFCMToken(forSenderID: "777777777777")
            #expect(senderToken.count == 142)
            #expect(senderToken != tokenA1)
            #expect(messagingA.fcmToken == tokenA1)
            try await messagingA.deleteFCMToken(forSenderID: "777777777777")

            // 2. Visibility routing + multi-app isolation: appA visible (foreground), appB hidden (background)
            try await messagingA.setVisibility(.visible)
            try await messagingB.setVisibility(.hidden)

            try await messagingA.subscribe(toTopic: "/topics/swift_live")
            try await messagingB.subscribe(toTopic: "swift_live")

            // Topic send fans out to BOTH recipients on their respective visibility routes!
            let topicSend = try await messagingA.sendBrokerMessage(
                MessagingBrokerMessage(
                    topic: "swift_live",
                    data: ["channel": "topic-fanout"],
                    notification: MessagingNotificationPayload(
                        title: "Live Alert",
                        body: "Swift FCM",
                        imageURL: "https://example.test/live.png"
                    )
                )
            )
            #expect(topicSend.name.hasPrefix("projects/\(projectID)/messages/"))

            let receivedFgA = try #require(await fgIterA.next())
            let receivedBgB = try #require(await bgIterB.next())
            #expect(receivedFgA.messageID == topicSend.messageID)
            #expect(receivedFgA.route == .foreground)
            #expect(receivedFgA.data["channel"] == "topic-fanout")
            #expect(receivedFgA.notification?.title == "Live Alert")
            #expect(receivedFgA.notification?.imageURL == "https://example.test/live.png")

            #expect(receivedBgB.messageID == topicSend.messageID)
            #expect(receivedBgB.route == .background)
            #expect(receivedBgB.data["channel"] == "topic-fanout")

            // Track downstream receipt and BigQuery metrics on receivedFgA
            messagingA.setDeliveryMetricsExportToBigQuery(true)
            let receiptInfo = messagingA.appDidReceiveMessage(receivedFgA.toUserInfo())
            #expect(receiptInfo.status == .new)
            #expect(messagingA.exportedDeliveryMetrics.count == 1)
            #expect(messagingA.exportedDeliveryMetrics[0]["gcm.message_id"] == receivedFgA.messageID)

            // 3. Boolean condition routing + dryRun (validateOnly) non-delivery
            let dryRun = try await messagingA.sendBrokerMessage(
                MessagingBrokerMessage(
                    condition: "'swift_live' in topics",
                    data: ["dryRun": "true"]
                ),
                validateOnly: true
            )
            #expect(dryRun.validateOnly == true)

            try await messagingB.unsubscribe(fromTopic: "swift_live")
            let condSend = try await messagingA.sendBrokerMessage(
                MessagingBrokerMessage(
                    condition: "'swift_live' in topics && !('muted' in topics)",
                    data: ["cond": "matched-a-only"]
                )
            )
            let condMsgA = try #require(await fgIterA.next())
            #expect(condMsgA.messageID == condSend.messageID)
            #expect(condMsgA.data["cond"] == "matched-a-only")

            // 4. Flip appA to hidden and drive via deliver(...) into backgroundMessages
            let deliveredHidden = try await messagingA.deliver(
                data: ["driver": "hidden-bg"],
                messageID: "swift-live-deliver-1",
                visibilityState: .hidden
            )
            #expect(deliveredHidden.route == .background)
            #expect(deliveredHidden.handlerCount == 1)
            let bgMsgA = try #require(await bgIterA.next())
            #expect(bgMsgA.messageID == "swift-live-deliver-1")
            #expect(bgMsgA.data["driver"] == "hidden-bg")

            // 5. deleteToken() invalidates tokenA1 immediately -> NOT_FOUND on send, then re-mints fresh token
            try await messagingA.deleteToken()
            #expect(messagingA.fcmToken == nil)
            do {
                _ = try await messagingA.sendBrokerMessage(
                    MessagingBrokerMessage(token: tokenA1, data: ["afterDelete": "1"])
                )
                Issue.record("Expected NOT_FOUND error when sending to deleted token")
            } catch let err as MessagingError {
                #expect(err.code == .invalidRequest)
                #expect(err.brokerStatus == "NOT_FOUND")
            }

            let rotatedTokenA = try await messagingA.token()
            #expect(rotatedTokenA.count == 142)
            #expect(rotatedTokenA != tokenA1)
            #expect(delegateA.snapshot() == [tokenA1, rotatedTokenA])

            await Messaging.evictInstance(for: appA)
            await Messaging.evictInstance(for: appB)
            await appA.delete()
            await appB.delete()
        }
    }
}
