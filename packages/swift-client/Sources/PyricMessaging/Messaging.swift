import Foundation
import PyricFirestore

package final class InFlightTokenGate: @unchecked Sendable {
    private let lock = NSLock()
    private var waiters: [CheckedContinuation<String, any Error>] = []
    private var finishedResult: Result<String, any Error>?

    package init() {}

    package func wait() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let result = finishedResult {
                lock.unlock()
                continuation.resume(with: result)
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    package func complete(with result: Result<String, any Error>) {
        let pending: [CheckedContinuation<String, any Error>] = {
            lock.lock()
            defer { lock.unlock() }
            if finishedResult != nil {
                return []
            }
            finishedResult = result
            let snapshot = waiters
            waiters.removeAll()
            return snapshot
        }()
        for waiter in pending {
            waiter.resume(with: result)
        }
    }
}

/// Entry point for Firebase Cloud Messaging (`PyricMessaging`), mirroring
/// `FirebaseMessaging.Messaging` (`firebase-ios-sdk:13.2.0`) over the Pyric WebSocket bridge.
public final class Messaging: NSObject, @unchecked Sendable {
    public static let defaultRegistrationID = "swreg-port-default"
    public static let defaultRecipientID = "sandbox-default"

    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var instances: [String: Messaging] = [:]
    private static let sharedExtensionHelper = MessagingExtensionHelper()

    public let app: FirebaseApp
    public let registrationID: String
    public let recipientID: String
    public let isInstallationIdEnabled: Bool
    public var isInstallationIDEnabled: Bool { isInstallationIdEnabled }

    package let wireRegistrationID: String?
    package let wireRecipientID: String?
    package let installationID: String
    package let hasInjectedTransport: Bool

    package let stateLock = NSLock()
    private weak var _delegate: (any MessagingDelegate)?
    private var _isAutoInitEnabled: Bool
    private var _isDeliveryMetricsExportEnabled = false
    private var _apnsToken: Data?
    private var _apnsTokenType: MessagingAPNSTokenType = .unknown
    package var _cachedToken: String?
    package var _lastAnnouncedToken: String?
    package var _inFlightTokenGate: InFlightTokenGate?
    package var _mintedSenderIDs: Set<String> = []
    private var _loggedMessageIDs: Set<String> = []
    private var _exportedDeliveryMetrics: [[String: String]] = []
    private var _emulatorOverride: ResolvedBridgeEndpoint?
    package var _lastSubscriptionError: MessagingError?
    package var _isDisposed = false

    package var foregroundContinuations: [UUID: AsyncStream<RemoteMessagingMessage>.Continuation] = [:]
    package var backgroundContinuations: [UUID: AsyncStream<RemoteMessagingMessage>.Continuation] = [:]
    package var foregroundHandlers: [UUID: @Sendable (RemoteMessagingMessage) -> Void] = [:]
    package var backgroundHandlers: [UUID: @Sendable (RemoteMessagingMessage) async -> Void] = [:]

    private var sessionStorage: MessagingBridgeSession?
    private var bridgeObserverID: UUID?

    package var session: MessagingBridgeSession {
        sessionStorage!
    }

    package init(
        app: FirebaseApp,
        registrationID: String? = nil,
        recipientID: String? = nil,
        installationIDEnabled: Bool = false,
        autoInitEnabled: Bool = true,
        transport: (any WebSocketTransport)? = nil
    ) {
        self.app = app
        let isDefaultApp = app.name == FirebaseApp.defaultAppName
        let resolvedReg = registrationID ?? (isDefaultApp ? Self.defaultRegistrationID : "swift-reg-\(app.name)")
        let resolvedRecip = recipientID ?? (isDefaultApp ? Self.defaultRecipientID : "swift-app-\(app.name)")
        self.registrationID = resolvedReg
        self.recipientID = resolvedRecip
        self.wireRegistrationID = (registrationID == nil && isDefaultApp) ? nil : resolvedReg
        self.wireRecipientID = (recipientID == nil && isDefaultApp) ? nil : resolvedRecip
        self.installationID = isDefaultApp ? "fid-swift-default" : "fid-swift-\(app.name)"
        self.isInstallationIdEnabled = installationIDEnabled
        self._isAutoInitEnabled = autoInitEnabled
        self.hasInjectedTransport = transport != nil
        super.init()

        self.sessionStorage = MessagingBridgeSession(
            fixedTransport: transport,
            wireRecipientID: self.wireRecipientID,
            observerState: { [weak self] in
                guard let self else { return (false, false) }
                return self.currentObserverIntent()
            },
            onDelivery: { [weak self] message in
                self?.dispatchDeliveredMessage(message)
            },
            onSubscriptionError: { [weak self] error in
                self?.recordSubscriptionError(error)
            }
        )

        if transport == nil {
            self.bridgeObserverID = app.addBridgeObserver { [weak self] nextClient in
                guard let self else { return }
                Task {
                    let hasOverride: Bool = {
                        self.stateLock.lock()
                        defer { self.stateLock.unlock() }
                        return self._emulatorOverride != nil
                    }()
                    if !hasOverride {
                        let endpoint = await nextClient.endpoint
                        let headers = await nextClient.headers
                        await self.session.reconfigureEndpoint(endpoint: endpoint, headers: headers)
                    }
                }
            }
        }
    }

    // MARK: - Factory & Instance Registry

    /// Returns the `Messaging` instance associated with the default `FirebaseApp`.
    public class func messaging() -> Messaging {
        messaging(app: FirebaseApp.app())
    }

    /// Returns the `Messaging` instance isolated to `app`.
    public class func messaging(app: FirebaseApp) -> Messaging {
        var evicted: Messaging?
        let instance: Messaging = {
            registryLock.lock()
            defer { registryLock.unlock() }
            if let existing = instances[app.name] {
                if existing.app === app && !existing.isDisposedState {
                    return existing
                }
                evicted = existing
            }
            let created = Messaging(app: app)
            instances[app.name] = created
            return created
        }()
        if let evicted {
            Task { await evicted.disconnect() }
        }
        return instance
    }

    /// Creates an isolated `Messaging` instance with custom registration/recipient IDs or an in-memory `WebSocketTransport`.
    public class func messaging(
        app: FirebaseApp? = nil,
        registrationID: String? = nil,
        recipientID: String? = nil,
        installationIDEnabled: Bool = false,
        autoInitEnabled: Bool = true,
        transport: (any WebSocketTransport)?
    ) -> Messaging {
        let resolvedApp = app ?? FirebaseApp.app()
        return Messaging(
            app: resolvedApp,
            registrationID: registrationID,
            recipientID: recipientID,
            installationIDEnabled: installationIDEnabled,
            autoInitEnabled: autoInitEnabled,
            transport: transport
        )
    }

    /// Returns the Notification Service Extension helper, matching `Messaging.serviceExtension()`.
    public class func serviceExtension() -> MessagingExtensionHelper {
        sharedExtensionHelper
    }

    /// Evicts the cached `Messaging` instance for `app` without disturbing sibling `FirebaseApp` instances.
    public class func evictInstance(for app: FirebaseApp) async {
        let removed: Messaging? = {
            registryLock.lock()
            defer { registryLock.unlock() }
            if instances[app.name]?.app === app {
                return instances.removeValue(forKey: app.name)
            }
            return nil
        }()
        if let removed {
            await removed.disconnect()
        }
    }

    // MARK: - Properties & APNs Configuration

    public var delegate: (any MessagingDelegate)? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _delegate
        }
        set {
            let existingToken: String? = {
                stateLock.lock()
                defer { stateLock.unlock() }
                _delegate = newValue
                return _cachedToken
            }()
            if let newValue, let existingToken {
                newValue.messaging(self, didReceiveRegistrationToken: existingToken)
            }
        }
    }

    public var isAutoInitEnabled: Bool {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _isAutoInitEnabled
        }
        set {
            let becameEnabled: Bool = {
                stateLock.lock()
                defer { stateLock.unlock() }
                let wasEnabled = _isAutoInitEnabled
                _isAutoInitEnabled = newValue
                return !wasEnabled && newValue && !isInstallationIdEnabled
            }()
            if becameEnabled && canAutoFetchToken() {
                Task { [weak self] in
                    _ = try? await self?.token()
                }
            }
        }
    }

    public var fcmToken: String? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _cachedToken
    }

    public var apnsToken: Data? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _apnsToken
        }
        set {
            stateLock.lock()
            _apnsToken = newValue
            if newValue == nil {
                _apnsTokenType = .unknown
            } else if _apnsTokenType == .unknown {
                _apnsTokenType = .unknown
            }
            stateLock.unlock()
        }
    }

    public var apnsTokenType: MessagingAPNSTokenType {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _apnsTokenType
    }

    public func setAPNSToken(_ apnsToken: Data, type: MessagingAPNSTokenType) {
        stateLock.lock()
        _apnsToken = apnsToken
        _apnsTokenType = type
        stateLock.unlock()
    }

    // MARK: - Analytics & appDidReceiveMessage

    public var isDeliveryMetricsExportToBigQueryEnabled: Bool {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _isDeliveryMetricsExportEnabled
        }
        set {
            stateLock.lock()
            _isDeliveryMetricsExportEnabled = newValue
            stateLock.unlock()
        }
    }

    public func setDeliveryMetricsExportToBigQuery(_ enabled: Bool) {
        isDeliveryMetricsExportToBigQueryEnabled = enabled
    }

    public var exportedDeliveryMetrics: [[String: String]] {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _exportedDeliveryMetrics
    }

    public func exportDeliveryMetrics(withMessageInfo info: [AnyHashable: Any]) {
        guard !info.isEmpty else { return }
        var normalized: [String: String] = [:]
        for (rawKey, rawValue) in info {
            guard let key = rawKey as? String else { continue }
            if let str = rawValue as? String {
                normalized[key] = str
            } else if let num = rawValue as? NSNumber {
                normalized[key] = num.stringValue
            }
        }
        stateLock.lock()
        _exportedDeliveryMetrics.append(normalized)
        stateLock.unlock()
    }

    /// Tracks downstream message receipt and deduplicates analytics per message ID,
    /// matching `FIRMessaging.appDidReceiveMessage(_:)`.
    public func appDidReceiveMessage(_ message: [AnyHashable: Any]) -> MessagingMessageInfo {
        guard !message.isEmpty else {
            return MessagingMessageInfo(status: .unknown)
        }
        let messageID = (message["gcm.message_id"] as? String) ?? (message["messageId"] as? String)
        let shouldLogMetrics: Bool = {
            stateLock.lock()
            defer { stateLock.unlock() }
            if let messageID, !messageID.isEmpty {
                if _loggedMessageIDs.contains(messageID) {
                    return false
                }
                _loggedMessageIDs.insert(messageID)
            }
            return _isDeliveryMetricsExportEnabled
        }()
        if shouldLogMetrics {
            exportDeliveryMetrics(withMessageInfo: message)
        }
        return MessagingMessageInfo(status: .new)
    }

    // MARK: - Emulator Routing & Lifecycle

    /// Routes this `Messaging` instance's WebSocket operations and streams to a local Pyric sandbox host.
    public func useEmulator(withHost host: String, port: Int, sslEnabled: Bool = false) {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedHost = trimmed == "10.0.2.2" ? "127.0.0.1" : trimmed
        let resolved = FirebaseBridgeEndpointResolver.emulatorEndpoint(
            host: normalizedHost,
            port: port,
            sslEnabled: sslEnabled
        )
        stateLock.lock()
        _emulatorOverride = resolved
        stateLock.unlock()
        Task { [weak self] in
            guard let self else { return }
            await self.session.reconfigureEndpoint(
                endpoint: resolved.endpoint,
                headers: ["Host": resolved.hostHeader]
            )
        }
    }

    public var lastSubscriptionError: MessagingError? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _lastSubscriptionError
    }

    /// Closes active foreground/background subscriptions and disconnects the underlying WebSocket session.
    public func disconnect() async {
        let (fgConts, bgConts, obsID): (
            [AsyncStream<RemoteMessagingMessage>.Continuation],
            [AsyncStream<RemoteMessagingMessage>.Continuation],
            UUID?
        ) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            _isDisposed = true
            let fg = Array(foregroundContinuations.values)
            let bg = Array(backgroundContinuations.values)
            foregroundContinuations.removeAll()
            backgroundContinuations.removeAll()
            foregroundHandlers.removeAll()
            backgroundHandlers.removeAll()
            let id = bridgeObserverID
            bridgeObserverID = nil
            return (fg, bg, id)
        }()
        if let obsID {
            app.removeBridgeObserver(obsID)
        }
        for cont in fgConts { cont.finish() }
        for cont in bgConts { cont.finish() }
        await session.disconnect()
    }

    // MARK: - Internal Helpers

    package var isDisposedState: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _isDisposed
    }

    package func resolveEndpointAndHeaders() async -> (endpoint: URL, headers: [String: String]) {
        let overrideSpec: ResolvedBridgeEndpoint? = {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _emulatorOverride
        }()
        if let overrideSpec {
            return (overrideSpec.endpoint, ["Host": overrideSpec.hostHeader])
        }
        let bridge = app.sharedBridgeClient()
        let endpoint = await bridge.endpoint
        let headers = await bridge.headers
        return (endpoint, headers)
    }

    package func clearLoggedMessagesAndMetrics() {
        stateLock.lock()
        _loggedMessageIDs.removeAll()
        _exportedDeliveryMetrics.removeAll()
        stateLock.unlock()
    }

    private func canAutoFetchToken() -> Bool {
        if hasInjectedTransport { return true }
        stateLock.lock()
        let hasOverride = _emulatorOverride != nil
        stateLock.unlock()
        if hasOverride { return true }
        if app.configuredBridgeHostSetting() != nil { return true }
        let env = ProcessInfo.processInfo.environment
        return env["PYRIC_BRIDGE_URL"] != nil || env["PYRIC_LIVE_BRIDGE_URL"] != nil
    }
}
