import Foundation
import Testing
import PyricFirestore
import PyricMessaging

private final class DelegateRecorder: MessagingDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var receivedTokens: [String?] = []
    private(set) var registeredInstallationIDs: [String?] = []
    private(set) var unregisteredInstallationIDs: [String] = []

    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        _ = messaging
        lock.lock()
        receivedTokens.append(fcmToken)
        lock.unlock()
    }

    func messaging(_ messaging: Messaging, didReceiveRegistration installationID: String?) {
        _ = messaging
        lock.lock()
        registeredInstallationIDs.append(installationID)
        lock.unlock()
    }

    func messaging(_ messaging: Messaging, didUnregister installationID: String) {
        _ = messaging
        lock.lock()
        unregisteredInstallationIDs.append(installationID)
        lock.unlock()
    }

    func snapshotTokens() -> [String?] {
        lock.lock()
        defer { lock.unlock() }
        return receivedTokens
    }

    func snapshotRegistered() -> [String?] {
        lock.lock()
        defer { lock.unlock() }
        return registeredInstallationIDs
    }

    func snapshotUnregistered() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return unregisteredInstallationIDs
    }
}

private final class NotificationRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String] = []
    private var unregisteredIDs: [String] = []

    func recordToken(_ token: String) {
        lock.lock()
        tokens.append(token)
        lock.unlock()
    }

    func recordUnregistered(_ id: String) {
        lock.lock()
        unregisteredIDs.append(id)
        lock.unlock()
    }

    func snapshotTokens() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return tokens
    }

    func snapshotUnregistered() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return unregisteredIDs
    }
}

@Suite("PyricMessaging Unit Suite", .serialized)
struct PyricMessagingUnitTests {
    private static func makeIsolatedApp(prefix: String) -> FirebaseApp {
        let name = "\(prefix)-\(UUID().uuidString)"
        let options = FirebaseOptions(
            projectID: "demo-unit-messaging",
            apiKey: "unit-messaging-key",
            googleAppID: "1:999999999999:ios:unitmessaging"
        )
        return FirebaseApp(name: name, options: options, environment: [:])
    }

    @Test("Coalesces concurrent token() calls, notifies delegate and NotificationCenter, and rotates on deleteToken()")
    func tokenLifecycleCoalescingDelegateAndNotifications() async throws {
        let app = Self.makeIsolatedApp(prefix: "unit-token")
        let channel = MockMessagingBridgeChannel(getTokenDelayNanoseconds: 15_000_000)
        let messaging = Messaging.messaging(app: app, transport: channel)
        let delegate = DelegateRecorder()
        messaging.delegate = delegate

        let notifRecorder = NotificationRecorder()
        let tokenObserver = NotificationCenter.default.addObserver(
            forName: .MessagingRegistrationTokenRefreshed,
            object: nil,
            queue: nil
        ) { notification in
            if let token = (notification.object as? String) ?? (notification.userInfo?["token"] as? String) {
                notifRecorder.recordToken(token)
            }
        }
        defer {
            NotificationCenter.default.removeObserver(tokenObserver)
        }

        async let t1 = messaging.token()
        async let t2 = messaging.token()
        async let t3 = messaging.token()
        let results = try await [t1, t2, t3]

        let firstToken = results[0]
        #expect(!firstToken.isEmpty)
        #expect(results == [firstToken, firstToken, firstToken])
        #expect(messaging.fcmToken == firstToken)

        let getTokenOps = channel.snapshotOps().filter { $0.method == "messaging.getToken" }
        #expect(getTokenOps.count == 1)
        #expect(delegate.snapshotTokens() == [firstToken])
        #expect(notifRecorder.snapshotTokens().contains(firstToken))

        // Setting a new delegate after fcmToken is cached immediately replays didReceiveRegistrationToken
        let lateDelegate = DelegateRecorder()
        messaging.delegate = lateDelegate
        #expect(lateDelegate.snapshotTokens() == [firstToken])

        try await messaging.deleteToken()
        #expect(messaging.fcmToken == nil)

        let rotatedToken = try await messaging.token()
        #expect(rotatedToken != firstToken)
        #expect(messaging.fcmToken == rotatedToken)
        #expect(lateDelegate.snapshotTokens() == [firstToken, rotatedToken])

        await messaging.disconnect()
        await app.delete()
    }

    @Test("Supports multi-sender tokens, deleteData(), APNs token types, completion handlers, and FID mode")
    func senderTokensCompletionHandlersAndInstallationIDMode() async throws {
        let app = Self.makeIsolatedApp(prefix: "unit-sender")
        let channel = MockMessagingBridgeChannel()
        let messaging = Messaging.messaging(app: app, autoInitEnabled: false, transport: channel)

        #expect(messaging.isAutoInitEnabled == false)
        let sampleAPNs = Data([0xDE, 0xAD, 0xBE, 0xEF])
        messaging.setAPNSToken(sampleAPNs, type: .sandbox)
        #expect(messaging.apnsToken == sampleAPNs)
        #expect(messaging.apnsTokenType == .sandbox)

        // Completion-handler token fetch
        let defaultToken: String = try await withCheckedThrowingContinuation { cont in
            messaging.token { tok, err in
                if let err {
                    cont.resume(throwing: err)
                } else {
                    cont.resume(returning: tok ?? "")
                }
            }
        }
        #expect(!defaultToken.isEmpty)
        #expect(messaging.fcmToken == defaultToken)

        // retrieveFCMToken(forSenderID:) mints a separate registration without overwriting fcmToken
        let senderToken = try await messaging.retrieveFCMToken(forSenderID: "123456789012")
        #expect(!senderToken.isEmpty)
        #expect(senderToken != defaultToken)
        #expect(messaging.fcmToken == defaultToken)

        do {
            _ = try await messaging.retrieveFCMToken(forSenderID: "   ")
            Issue.record("Expected invalidRequest for blank senderID")
        } catch let err as MessagingError {
            #expect(err.code == .invalidRequest)
        }

        try await messaging.deleteFCMToken(forSenderID: "123456789012")
        try await messaging.deleteData()
        #expect(messaging.fcmToken == nil)

        // Installation-ID-only mode rejects legacy token methods while allowing register() / unregister()
        let fidApp = Self.makeIsolatedApp(prefix: "unit-fid")
        let fidChannel = MockMessagingBridgeChannel()
        let fidMessaging = Messaging.messaging(
            app: fidApp,
            installationIDEnabled: true,
            transport: fidChannel
        )
        let fidDelegate = DelegateRecorder()
        fidMessaging.delegate = fidDelegate

        let notifRecorder = NotificationRecorder()
        let unregObserver = NotificationCenter.default.addObserver(
            forName: .messagingInstallationIdUnregistered,
            object: nil,
            queue: nil
        ) { notification in
            if let fid = notification.object as? String {
                notifRecorder.recordUnregistered(fid)
            }
        }
        defer {
            NotificationCenter.default.removeObserver(unregObserver)
        }

        do {
            _ = try await fidMessaging.token()
            Issue.record("Expected token() to throw when isInstallationIdEnabled is true")
        } catch let err as MessagingError {
            #expect(err.code == .invalidRequest)
        }

        try await fidMessaging.register()
        #expect(fidDelegate.snapshotRegistered() == ["fid-swift-\(fidApp.name)"])

        try await fidMessaging.unregister()
        #expect(fidDelegate.snapshotUnregistered() == ["fid-swift-\(fidApp.name)"])
        #expect(notifRecorder.snapshotUnregistered().contains("fid-swift-\(fidApp.name)"))

        await messaging.disconnect()
        await fidMessaging.disconnect()
        await app.delete()
        await fidApp.delete()
    }

    @Test("Validates topic names locally before any bridge op and strips optional /topics/ prefix")
    func topicValidationAndSubscriptionOutcomes() async throws {
        let app = Self.makeIsolatedApp(prefix: "unit-topics")
        let channel = MockMessagingBridgeChannel()
        let messaging = Messaging.messaging(app: app, transport: channel)

        let invalidTopics = [
            "",
            "/topics/",
            "bad/slash",
            "has space",
            "invalid$symbol",
            String(repeating: "a", count: 901),
        ]
        for bad in invalidTopics {
            do {
                try await messaging.subscribe(toTopic: bad)
                Issue.record("Expected invalidTopicName for '\(bad)'")
            } catch {
                let ns = error as NSError
                #expect(ns.domain == MessagingErrorDomain)
                #expect(ns.code == MessagingError.invalidTopicName.rawValue)
            }
        }
        // Invalid topics must fail before minting a token or dispatching any wire op
        #expect(channel.snapshotOps().isEmpty)

        try await messaging.subscribe(toTopic: "/topics/breaking-news_1.0~%20")
        try await messaging.unsubscribe(fromTopic: "breaking-news_1.0~%20")

        let topicOps = channel.snapshotOps().filter {
            $0.method == "messaging.subscribeToTopic" || $0.method == "messaging.unsubscribeFromTopic"
        }
        #expect(topicOps.count == 2)
        #expect(topicOps[0].params["topic"]?.stringValue == "breaking-news_1.0~%20")
        #expect(topicOps[1].params["topic"]?.stringValue == "breaking-news_1.0~%20")

        await messaging.disconnect()
        await app.delete()
    }

    @Test("Routes foreground and background streams, acknowledgments, sendBrokerMessage, appDidReceiveMessage, and disabled errors")
    func streamsVisibilitySendAcknowledgeAndDisabledCapability() async throws {
        let app = Self.makeIsolatedApp(prefix: "unit-streams")
        let channel = MockMessagingBridgeChannel()
        let messaging = Messaging.messaging(app: app, transport: channel)
        messaging.setDeliveryMetricsExportToBigQuery(true)

        var fgIterator = messaging.foregroundMessages.makeAsyncIterator()
        var bgIterator = messaging.backgroundMessages.makeAsyncIterator()

        let token = try await messaging.token()
        try await messaging.subscribe(toTopic: "alerts")

        // Visible -> foregroundMessages
        try await messaging.setVisibility(.visible)
        let acceptedTopic = try await messaging.sendBrokerMessage(
            MessagingBrokerMessage(
                topic: "alerts",
                data: ["kind": "fg-topic"],
                notification: MessagingNotificationPayload(
                    title: "Hello",
                    body: "World",
                    imageURL: "https://example.test/banner.png"
                )
            )
        )
        #expect(!acceptedTopic.messageID.isEmpty)
        #expect(acceptedTopic.name == "projects/demo-unit-messaging/messages/\(acceptedTopic.messageID)")
        #expect(acceptedTopic.validateOnly == false)

        let fgMsg = try #require(await fgIterator.next())
        #expect(fgMsg.messageID == acceptedTopic.messageID)
        #expect(fgMsg.route == .foreground)
        #expect(fgMsg.data["kind"] == "fg-topic")
        #expect(fgMsg.notification?.title == "Hello")
        #expect(fgMsg.notification?.imageURL == "https://example.test/banner.png")

        try await messaging.acknowledge(message: fgMsg, stage: .received)
        try await messaging.acknowledge(message: fgMsg, stage: .handlerCompleted)
        #expect(channel.snapshotAcknowledgments().count == 2)

        // appDidReceiveMessage deduplicates by gcm.message_id and exports BigQuery metrics once
        let userInfo = fgMsg.toUserInfo()
        let emptyInfo = messaging.appDidReceiveMessage([:])
        #expect(emptyInfo.status == .unknown)
        let firstReceipt = messaging.appDidReceiveMessage(userInfo)
        let duplicateReceipt = messaging.appDidReceiveMessage(userInfo)
        #expect(firstReceipt.status == .new)
        #expect(duplicateReceipt.status == .new)
        #expect(messaging.exportedDeliveryMetrics.count == 1)
        #expect(messaging.exportedDeliveryMetrics[0]["gcm.message_id"] == fgMsg.messageID)

        let extHelper = Messaging.serviceExtension()
        extHelper.resetExportedMetrics()
        extHelper.exportDeliveryMetricsToBigQuery(withMessageInfo: userInfo)
        #expect(extHelper.exportedMetrics.count == 1)

        // Hidden -> backgroundMessages (and validateOnly dry-run produces 0 deliveries)
        try await messaging.setVisibility(.hidden)
        let dryRun = try await messaging.sendBrokerMessage(
            MessagingBrokerMessage(token: token, data: ["dry": "1"]),
            validateOnly: true
        )
        #expect(dryRun.validateOnly == true)
        #expect(dryRun.name == "projects/demo-unit-messaging/messages/\(dryRun.messageID)")

        let deliveredBg = try await messaging.deliver(
            data: ["bgKey": "bgVal"],
            messageID: "custom-bg-1"
        )
        #expect(deliveredBg.route == .background)
        #expect(deliveredBg.handlerCount == 1)
        let bgMsg = try #require(await bgIterator.next())
        #expect(bgMsg.messageID == "custom-bg-1")
        #expect(bgMsg.route == .background)
        #expect(bgMsg.data["bgKey"] == "bgVal")
        #expect(bgMsg.notification == nil)

        // Deleted token rejects direct sendBrokerMessage with NOT_FOUND -> invalidRequest
        try await messaging.deleteToken()
        do {
            _ = try await messaging.sendBrokerMessage(MessagingBrokerMessage(token: token, data: ["dead": "1"]))
            Issue.record("Expected NOT_FOUND error sending to deleted token")
        } catch let err as MessagingError {
            #expect(err.code == .invalidRequest)
            #expect(err.brokerStatus == "NOT_FOUND")
        }

        await messaging.disconnect()
        withExtendedLifetime((fgIterator, bgIterator)) {}
        #expect(channel.snapshotUnsubIDs().count == 2)
        await app.delete()

        // Host with messagingEnabled == false maps messaging/disabled -> MessagingError.disabled
        let disabledApp = Self.makeIsolatedApp(prefix: "unit-disabled")
        let disabledChannel = MockMessagingBridgeChannel(messagingEnabled: false)
        let disabledMessaging = Messaging.messaging(app: disabledApp, transport: disabledChannel)
        do {
            _ = try await disabledMessaging.token()
            Issue.record("Expected MessagingError.disabled")
        } catch let err as MessagingError {
            #expect(err.code == .disabled)
        }
        await disabledMessaging.disconnect()
        await disabledApp.delete()
    }

    @Test("sendBrokerMessage normalizes broker receipt project segment from FirebaseOptions.projectID")
    func sendBrokerMessageReceiptProjectIDNormalization() async throws {
        let projectlessApp = FirebaseApp(
            name: "unit-projectless-\(UUID().uuidString)",
            options: FirebaseOptions(projectID: nil, apiKey: "k", googleAppID: "1:1:ios:none"),
            environment: [:]
        )
        let channel = MockMessagingBridgeChannel()
        let messaging = Messaging.messaging(app: projectlessApp, transport: channel)
        let token = try await messaging.token()
        let fallbackReceipt = try await messaging.sendBrokerMessage(
            MessagingBrokerMessage(token: token, data: ["probe": "fallback"])
        )
        #expect(fallbackReceipt.name == "projects/mock-project/messages/\(fallbackReceipt.messageID)")

        let blankApp = FirebaseApp(
            name: "unit-blank-project-\(UUID().uuidString)",
            options: FirebaseOptions(projectID: "   ", apiKey: "k", googleAppID: "1:1:ios:blank"),
            environment: [:]
        )
        let blankChannel = MockMessagingBridgeChannel()
        let blankMessaging = Messaging.messaging(app: blankApp, transport: blankChannel)
        let blankToken = try await blankMessaging.token()
        let blankReceipt = try await blankMessaging.sendBrokerMessage(
            MessagingBrokerMessage(token: blankToken, data: ["probe": "blank"])
        )
        #expect(blankReceipt.name == "projects/mock-project/messages/\(blankReceipt.messageID)")

        await messaging.disconnect()
        await blankMessaging.disconnect()
        await projectlessApp.delete()
        await blankApp.delete()
    }
}
