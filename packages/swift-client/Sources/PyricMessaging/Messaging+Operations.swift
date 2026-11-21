import Foundation
import PyricFirestore

extension Messaging {
    // MARK: - Token & Registration Lifecycle

    /// Asynchronously fetches or mints the default FCM registration token (`messaging.getToken`).
    public func token() async throws -> String {
        try ensureTokensSupported(operation: "token()")
        return try await fetchOrMintDefaultToken()
    }

    /// Completion-handler overload for `token()`.
    public func token(completion: @escaping @Sendable (String?, (any Error)?) -> Void) {
        Task {
            do {
                let resolved = try await self.token()
                completion(resolved, nil)
            } catch {
                completion(nil, error)
            }
        }
    }

    /// Retrieves a non-cached FCM registration token scoped to a specific `senderID`,
    /// matching `Messaging.retrieveFCMToken(forSenderID:)`.
    public func retrieveFCMToken(forSenderID senderID: String) async throws -> String {
        try ensureTokensSupported(operation: "retrieveFCMToken(forSenderID:)")
        let trimmed = senderID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw MessagingError(code: .invalidRequest, message: "Sender ID must not be empty.")
        }
        let senderRegistrationID = "\(registrationID):sender:\(trimmed)"
        var params: [String: AnySendable] = ["registrationId": .string(senderRegistrationID)]
        if let wireRecipientID {
            params["recipientId"] = .string(wireRecipientID)
        }
        let raw = try await runBridgeOp(method: "messaging.getToken", params: params)
        guard let minted = raw.dictionaryValue?["token"]?.stringValue, !minted.isEmpty else {
            throw MessagingError(
                code: .unknown,
                message: "messaging.getToken returned an empty sender-scoped token."
            )
        }
        stateLock.withLock {
            _ = _mintedSenderIDs.insert(trimmed)
        }
        return minted
    }

    /// Completion-handler overload for `retrieveFCMToken(forSenderID:)`.
    public func retrieveFCMToken(
        forSenderID senderID: String,
        completion: @escaping @Sendable (String?, (any Error)?) -> Void
    ) {
        Task {
            do {
                let resolved = try await self.retrieveFCMToken(forSenderID: senderID)
                completion(resolved, nil)
            } catch {
                completion(nil, error)
            }
        }
    }

    /// Deletes the default FCM registration token on the broker (`messaging.deleteToken`) and clears `fcmToken`.
    public func deleteToken() async throws {
        try ensureTokensSupported(operation: "deleteToken()")
        try await deleteDefaultRegistrationOnBroker()
    }

    /// Completion-handler overload for `deleteToken()`.
    public func deleteToken(completion: @escaping @Sendable ((any Error)?) -> Void) {
        Task {
            do {
                try await self.deleteToken()
                completion(nil)
            } catch {
                completion(error)
            }
        }
    }

    /// Invalidates the FCM token previously minted for `senderID` (`messaging.deleteToken`).
    public func deleteFCMToken(forSenderID senderID: String) async throws {
        try ensureTokensSupported(operation: "deleteFCMToken(forSenderID:)")
        let trimmed = senderID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw MessagingError(code: .invalidRequest, message: "Sender ID must not be empty.")
        }
        let senderRegistrationID = "\(registrationID):sender:\(trimmed)"
        var params: [String: AnySendable] = ["registrationId": .string(senderRegistrationID)]
        if let wireRecipientID {
            params["recipientId"] = .string(wireRecipientID)
        }
        _ = try await runBridgeOp(method: "messaging.deleteToken", params: params)
        stateLock.withLock {
            _ = _mintedSenderIDs.remove(trimmed)
        }
    }

    /// Completion-handler overload for `deleteFCMToken(forSenderID:)`.
    public func deleteFCMToken(
        forSenderID senderID: String,
        completion: @escaping @Sendable ((any Error)?) -> Void
    ) {
        Task {
            do {
                try await self.deleteFCMToken(forSenderID: senderID)
                completion(nil)
            } catch {
                completion(error)
            }
        }
    }

    /// Deletes all FCM registrations (default and sender-scoped) and clears local Messaging state,
    /// matching `FIRMessaging.deleteDataWithCompletion:` (`deleteData()`).
    public func deleteData() async throws {
        let senderIDs: [String] = {
            stateLock.lock()
            defer { stateLock.unlock() }
            let current = Array(_mintedSenderIDs)
            _mintedSenderIDs.removeAll()
            return current
        }()
        try await deleteDefaultRegistrationOnBroker()
        for sender in senderIDs {
            var params: [String: AnySendable] = ["registrationId": .string("\(registrationID):sender:\(sender)")]
            if let wireRecipientID {
                params["recipientId"] = .string(wireRecipientID)
            }
            _ = try await runBridgeOp(method: "messaging.deleteToken", params: params)
        }
        clearLoggedMessagesAndMetrics()
    }

    /// Completion-handler overload for `deleteData()`.
    public func deleteData(completion: @escaping @Sendable ((any Error)?) -> Void) {
        Task {
            do {
                try await self.deleteData()
                completion(nil)
            } catch {
                completion(error)
            }
        }
    }

    /// Registers the app instance with FCM and invokes `delegate.messaging(_:didReceiveRegistration:)`,
    /// matching `FIRMessaging.registerWithCompletion:` in `FirebaseMessaging 13.2.0`.
    public func register() async throws {
        _ = try await fetchOrMintDefaultToken()
        delegate?.messaging(self, didReceiveRegistration: installationID)
    }

    /// Completion-handler overload for `register()`.
    public func register(completion: @escaping @Sendable ((any Error)?) -> Void) {
        Task {
            do {
                try await self.register()
                completion(nil)
            } catch {
                completion(error)
            }
        }
    }

    /// Unregisters the app instance from FCM, invokes `delegate.messaging(_:didUnregister:)`, and posts
    /// `Notification.Name.messagingInstallationIdUnregistered`, matching `FIRMessaging.unregisterWithCompletion:`.
    public func unregister() async throws {
        try await deleteDefaultRegistrationOnBroker()
        delegate?.messaging(self, didUnregister: installationID)
        NotificationCenter.default.post(
            name: .messagingInstallationIdUnregistered,
            object: installationID,
            userInfo: ["installationID": installationID]
        )
    }

    /// Completion-handler overload for `unregister()`.
    public func unregister(completion: @escaping @Sendable ((any Error)?) -> Void) {
        Task {
            do {
                try await self.unregister()
                completion(nil)
            } catch {
                completion(error)
            }
        }
    }

    // MARK: - Topic Subscriptions

    /// Subscribes this app's active FCM registration to `topic` (`messaging.subscribeToTopic`),
    /// stripping an optional `"/topics/"` prefix and validating `[a-zA-Z0-9-_.~%]{1,900}` locally.
    public func subscribe(toTopic topic: String) async throws {
        try await mutateTopicSubscription(topic: topic, subscribe: true)
    }

    /// Completion-handler overload for `subscribe(toTopic:)`.
    public func subscribe(
        toTopic topic: String,
        completion: (@Sendable ((any Error)?) -> Void)?
    ) {
        Task {
            do {
                try await self.subscribe(toTopic: topic)
                completion?(nil)
            } catch {
                completion?(error)
            }
        }
    }

    /// Unsubscribes this app's active FCM registration from `topic` (`messaging.unsubscribeFromTopic`),
    /// stripping an optional `"/topics/"` prefix and validating `[a-zA-Z0-9-_.~%]{1,900}` locally.
    public func unsubscribe(fromTopic topic: String) async throws {
        try await mutateTopicSubscription(topic: topic, subscribe: false)
    }

    /// Completion-handler overload for `unsubscribe(fromTopic:)`.
    public func unsubscribe(
        fromTopic topic: String,
        completion: (@Sendable ((any Error)?) -> Void)?
    ) {
        Task {
            do {
                try await self.unsubscribe(fromTopic: topic)
                completion?(nil)
            } catch {
                completion?(error)
            }
        }
    }

    // MARK: - Sandbox Visibility, Delivery Driver, Send Plane, & Acknowledgments

    /// Reports simulated client window visibility (`visible` or `hidden`) to `messaging.setVisibility`,
    /// controlling whether deliveries route to `foregroundMessages` or `backgroundMessages`.
    public func setVisibility(_ state: MessagingVisibilityState) async throws {
        var params: [String: AnySendable] = ["state": .string(state.rawValue)]
        if let wireRecipientID {
            params["recipientId"] = .string(wireRecipientID)
        }
        _ = try await runBridgeOp(method: "messaging.setVisibility", params: params)
    }

    /// String-accepting overload for `setVisibility(_:)` validating `"visible"` or `"hidden"`.
    public func setVisibility(_ rawState: String) async throws {
        let normalized = rawState.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let parsed = MessagingVisibilityState(rawValue: normalized) else {
            throw MessagingError(
                code: .invalidRequest,
                message: "Visibility state must be 'visible' or 'hidden', received '\(rawState)'."
            )
        }
        try await setVisibility(parsed)
    }

    /// Injects a test delivery directly into the sandbox client plane (`messaging.deliver`),
    /// routing exclusively to foreground or background observers according to visibility.
    @discardableResult
    public func deliver(
        data: [String: String]? = nil,
        notification: MessagingNotificationPayload? = nil,
        from: String? = nil,
        messageID: String? = nil,
        visibilityState: MessagingVisibilityState? = nil
    ) async throws -> MessagingDeliveryResult {
        var spec: [String: AnySendable] = [:]
        if let data {
            var wireData: [String: AnySendable] = [:]
            for (k, v) in data {
                wireData[k] = .string(v)
            }
            spec["data"] = .dictionary(wireData)
        }
        if let notification {
            let notifWire = notification.toDeliverWire()
            if !notifWire.isEmpty {
                spec["notification"] = .dictionary(notifWire)
            }
        }
        if let from {
            spec["from"] = .string(from)
        }
        if let messageID {
            spec["messageId"] = .string(messageID)
        }
        if let visibilityState {
            spec["visibilityState"] = .string(visibilityState.rawValue)
        }

        var params: [String: AnySendable] = ["spec": .dictionary(spec)]
        if let wireRecipientID {
            params["recipientId"] = .string(wireRecipientID)
        }
        let raw = try await runBridgeOp(method: "messaging.deliver", params: params)
        return try MessagingDeliveryResult.fromWire(raw)
    }

    /// Sends a message through the sandbox `MessagingBroker` send plane (`messaging.send`),
    /// targeting a registration `token`, `topic`, or boolean topic `condition`.
    @discardableResult
    public func sendBrokerMessage(
        _ message: MessagingBrokerMessage,
        validateOnly: Bool = false
    ) async throws -> AcceptedMessagingSend {
        var params: [String: AnySendable] = ["message": message.toAnySendable()]
        if validateOnly {
            params["validateOnly"] = .bool(true)
        }
        let raw = try await runBridgeOp(method: "messaging.send", params: params)
        return try AcceptedMessagingSend.fromWire(raw)
    }

    /// Acknowledges a `RemoteMessagingMessage` received on an active subscription (`messaging.acknowledge`).
    public func acknowledge(
        message: RemoteMessagingMessage,
        stage: MessagingDeliveryStage = .received
    ) async throws {
        guard let subID = message.subscriptionID, !subID.isEmpty else {
            throw MessagingError(
                code: .invalidRequest,
                message: "Cannot acknowledge a message without an originating subscriptionID."
            )
        }
        try await acknowledge(subscriptionID: subID, messageID: message.messageID, stage: stage)
    }

    /// Acknowledges a delivered `messageID` on `subscriptionID` at `stage` (`messaging.acknowledge`).
    public func acknowledge(
        subscriptionID: String,
        messageID: String,
        stage: MessagingDeliveryStage
    ) async throws {
        guard !subscriptionID.isEmpty, !messageID.isEmpty else {
            throw MessagingError(
                code: .invalidRequest,
                message: "subscriptionID and messageID must be non-empty for messaging.acknowledge."
            )
        }
        let params: [String: AnySendable] = [
            "subId": .string(subscriptionID),
            "messageId": .string(messageID),
            "stage": .string(stage.rawValue),
        ]
        _ = try await runBridgeOp(method: "messaging.acknowledge", params: params)
    }

    // MARK: - Internal Token & Topic Execution

    private func ensureTokensSupported(operation: String) throws {
        if isInstallationIdEnabled {
            throw MessagingError(
                code: .invalidRequest,
                message: "\(operation) is not supported when isInstallationIdEnabled is true; use register() and unregister() instead."
            )
        }
    }

    package func fetchOrMintDefaultToken() async throws -> String {
        enum FetchAction {
            case cached(String)
            case join(InFlightTokenGate)
            case initiate(InFlightTokenGate)
        }

        let action: FetchAction = {
            stateLock.lock()
            defer { stateLock.unlock() }
            if let existing = _cachedToken {
                return .cached(existing)
            }
            if let existingGate = _inFlightTokenGate {
                return .join(existingGate)
            }
            let newGate = InFlightTokenGate()
            _inFlightTokenGate = newGate
            return .initiate(newGate)
        }()

        switch action {
        case .cached(let token):
            return token
        case .join(let gate):
            return try await gate.wait()
        case .initiate(let gate):
            do {
                var params: [String: AnySendable] = [:]
                if let wireRegistrationID {
                    params["registrationId"] = .string(wireRegistrationID)
                }
                if let wireRecipientID {
                    params["recipientId"] = .string(wireRecipientID)
                }
                let raw = try await runBridgeOp(method: "messaging.getToken", params: params)
                guard let minted = raw.dictionaryValue?["token"]?.stringValue, !minted.isEmpty else {
                    throw MessagingError(
                        code: .unknown,
                        message: "messaging.getToken response lacked a non-empty token."
                    )
                }
                let shouldAnnounce: Bool = {
                    stateLock.lock()
                    defer { stateLock.unlock() }
                    if _inFlightTokenGate === gate {
                        _inFlightTokenGate = nil
                        if !isInstallationIdEnabled {
                            _cachedToken = minted
                        }
                    }
                    let changed = _lastAnnouncedToken != minted
                    _lastAnnouncedToken = minted
                    return changed && !isInstallationIdEnabled
                }()
                if shouldAnnounce {
                    delegate?.messaging(self, didReceiveRegistrationToken: minted)
                    NotificationCenter.default.post(
                        name: .MessagingRegistrationTokenRefreshed,
                        object: minted,
                        userInfo: ["token": minted]
                    )
                }
                gate.complete(with: .success(minted))
                return minted
            } catch {
                let mapped = MessagingError.from(error)
                stateLock.withLock {
                    if _inFlightTokenGate === gate {
                        _inFlightTokenGate = nil
                    }
                }
                gate.complete(with: .failure(mapped))
                throw mapped
            }
        }
    }

    private func deleteDefaultRegistrationOnBroker() async throws {
        var params: [String: AnySendable] = [:]
        if let wireRegistrationID {
            params["registrationId"] = .string(wireRegistrationID)
        }
        if let wireRecipientID {
            params["recipientId"] = .string(wireRecipientID)
        }
        _ = try await runBridgeOp(method: "messaging.deleteToken", params: params)
        stateLock.withLock {
            _cachedToken = nil
            _lastAnnouncedToken = nil
            _inFlightTokenGate = nil
        }
    }

    private func mutateTopicSubscription(topic: String, subscribe: Bool) async throws {
        let normalizedTopic = try MessagingTopicValidator.normalize(topic)
        let activeToken = try await fetchOrMintDefaultToken()
        let method = subscribe ? "messaging.subscribeToTopic" : "messaging.unsubscribeFromTopic"
        let params: [String: AnySendable] = [
            "tokens": .array([.string(activeToken)]),
            "topic": .string(normalizedTopic),
        ]
        let raw = try await runBridgeOp(method: method, params: params)
        if let dict = raw.dictionaryValue,
           let failureCount = dict["failureCount"]?.intValue,
           failureCount > 0 {
            let firstReason = dict["errors"]?.arrayValue?.first?.dictionaryValue?["reason"]?.stringValue
                ?? "topic-operation-failed"
            throw MessagingError(
                code: .invalidRequest,
                message: "Topic operation '\(method)' failed for '\(normalizedTopic)': \(firstReason).",
                brokerStatus: firstReason
            )
        }
    }

    private func runBridgeOp(
        method: String,
        params: [String: AnySendable]
    ) async throws -> AnySendable {
        let resolved = await resolveEndpointAndHeaders()
        do {
            return try await session.unaryOp(
                endpoint: resolved.endpoint,
                headers: resolved.headers,
                method: method,
                params: params
            )
        } catch {
            throw MessagingError.from(error)
        }
    }
}
