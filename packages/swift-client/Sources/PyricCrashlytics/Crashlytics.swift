import Foundation
import PyricAppCheck
import PyricFirestore

/// Entry point for Firebase Crashlytics (`PyricCrashlytics`), mirroring
/// `FirebaseCrashlytics.Crashlytics` (`FIRCrashlytics` in `firebase-ios-sdk:13.2.0`)
/// over the shared Pyric `crashlytics.*` WebSocket bridge contract.
public final class Crashlytics: NSObject, @unchecked Sendable {
    package static let sdkPlatformIOS = "ios"
    package static let maxBreadcrumbs = 256

    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var instances: [String: Crashlytics] = [:]

    public let app: FirebaseApp
    package let wireAppID: String?

    private let usesAppBridge: Bool
    private let ownsInitialBridgeClient: Bool
    package let clockMillis: @Sendable () -> Int64
    package let serialQueue = CrashlyticsSerialQueue()
    package let stateLock = NSLock()

    package var _bridgeClient: PyricBridgeClient
    private var _ownedOverrideClient: PyricBridgeClient?
    private var bridgeObserverID: UUID?
    package var _collectionOverride: Bool?
    package var _didPreviouslyCrash: Bool = false
    package var _breadcrumbs: [CrashlyticsBreadcrumbEntry] = []
    package var _isDisposed: Bool = false

    @available(*, unavailable, message: "Use Crashlytics.crashlytics() or Crashlytics.crashlytics(app:).")
    override public init() {
        fatalError("Crashlytics cannot be initialized directly with init().")
    }

    package init(
        app: FirebaseApp,
        explicitBridgeClient: PyricBridgeClient? = nil,
        ownsInitialBridgeClient: Bool = false,
        clockMillis: @escaping @Sendable () -> Int64 = {
            Int64((Date().timeIntervalSince1970 * 1000.0).rounded())
        }
    ) {
        self.app = app
        self.wireAppID = (app.name == FirebaseApp.defaultAppName) ? nil : app.name
        self.usesAppBridge = (explicitBridgeClient == nil)
        self.ownsInitialBridgeClient = ownsInitialBridgeClient
        self.clockMillis = clockMillis
        self._bridgeClient = explicitBridgeClient ?? app.sharedBridgeClient()
        super.init()

        if usesAppBridge {
            self.bridgeObserverID = app.addBridgeObserver { [weak self] nextClient in
                self?.adoptObservedAppBridge(nextClient)
            }
        }
    }

    deinit {
        let obsID: UUID? = stateLock.withLock {
            let id = bridgeObserverID
            bridgeObserverID = nil
            return id
        }
        if let obsID {
            app.removeBridgeObserver(obsID)
        }
    }

    // MARK: - Factory & Per-App Instance Registry

    /// Accesses the `Crashlytics` instance associated with the default `FirebaseApp`.
    public class func crashlytics() -> Crashlytics {
        crashlytics(app: FirebaseApp.app())
    }

    /// Accesses the `Crashlytics` instance isolated to `app`.
    public class func crashlytics(app: FirebaseApp) -> Crashlytics {
        var evicted: Crashlytics?
        let resolved: Crashlytics = registryLock.withLock {
            if let existing = instances[app.name] {
                if existing.app === app && !existing.isDisposedState {
                    return existing
                }
                evicted = existing
            }
            let created = Crashlytics(app: app)
            instances[app.name] = created
            return created
        }
        if let evicted {
            Task { await evicted.disconnect() }
        }
        return resolved
    }

    /// Creates or retrieves an isolated `Crashlytics` instance bound to an explicit `PyricBridgeClient`.
    public class func crashlytics(
        app: FirebaseApp,
        bridgeClient: PyricBridgeClient
    ) -> Crashlytics {
        Crashlytics(app: app, explicitBridgeClient: bridgeClient, ownsInitialBridgeClient: false)
    }

    /// Creates an isolated `Crashlytics` instance backed by a custom `WebSocketTransport` (such as an in-memory test channel).
    public class func crashlytics(
        app: FirebaseApp? = nil,
        transport: any WebSocketTransport,
        clockMillis: @escaping @Sendable () -> Int64 = {
            Int64((Date().timeIntervalSince1970 * 1000.0).rounded())
        }
    ) -> Crashlytics {
        let resolvedApp = app ?? FirebaseApp.app()
        let dedicatedClient = PyricBridgeClient(channel: transport)
        return Crashlytics(
            app: resolvedApp,
            explicitBridgeClient: dedicatedClient,
            ownsInitialBridgeClient: true,
            clockMillis: clockMillis
        )
    }

    /// Evicts and disconnects the cached `Crashlytics` instance for `app` without disturbing sibling `FirebaseApp` instances.
    public class func evictInstance(for app: FirebaseApp) async {
        let removed: Crashlytics? = registryLock.withLock {
            if instances[app.name]?.app === app {
                return instances.removeValue(forKey: app.name)
            }
            return nil
        }
        if let removed {
            await removed.disconnect()
        }
    }

    /// Evicts all cached `Crashlytics` instances across apps.
    public class func reset() {
        let removed: [Crashlytics] = registryLock.withLock {
            let all = Array(instances.values)
            instances.removeAll()
            return all
        }
        for item in removed {
            Task { await item.disconnect() }
        }
    }

    // MARK: - Emulator Routing & Bridge Lifecycle

    /// Active `PyricBridgeClient` used for `crashlytics.*` operations.
    public var bridgeClient: PyricBridgeClient {
        stateLock.withLock { _bridgeClient }
    }

    /// Routes this `Crashlytics` instance's WebSocket operations to a local Pyric sandbox host.
    public func useEmulator(withHost host: String, port: Int, sslEnabled: Bool = false) {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        precondition(!trimmed.isEmpty, "Invalid host argument: Cannot connect to empty host.")
        precondition(port >= 0 && port <= 65535, "Invalid port argument: Port must be between 0 and 65535.")
        let normalizedHost = trimmed == "10.0.2.2" ? "127.0.0.1" : trimmed
        let resolved = FirebaseBridgeEndpointResolver.emulatorEndpoint(
            host: normalizedHost,
            port: port,
            sslEnabled: sslEnabled
        )
        let dedicated = PyricBridgeClient(
            endpoint: resolved.endpoint,
            headers: ["Host": resolved.hostHeader]
        )
        let staleOverride: PyricBridgeClient? = stateLock.withLock {
            let previousOverride = _ownedOverrideClient
            _ownedOverrideClient = dedicated
            _bridgeClient = dedicated
            return previousOverride
        }
        if let staleOverride {
            Task { await staleOverride.disconnect() }
        }
    }

    /// Drains queued Crashlytics operations and closes any owned bridge session.
    public func disconnect() async {
        let (obsID, ownedOverride, initialOwned): (UUID?, PyricBridgeClient?, PyricBridgeClient?) = stateLock.withLock {
            if _isDisposed {
                return (nil, nil, nil)
            }
            _isDisposed = true
            let id = bridgeObserverID
            bridgeObserverID = nil
            let overrideClient = _ownedOverrideClient
            _ownedOverrideClient = nil
            let initial = ownsInitialBridgeClient ? _bridgeClient : nil
            return (id, overrideClient, initial)
        }
        if let obsID {
            app.removeBridgeObserver(obsID)
        }
        await serialQueue.closeAndDrain()
        if let ownedOverride {
            await ownedOverride.disconnect()
        }
        if let initialOwned, initialOwned !== ownedOverride {
            await initialOwned.disconnect()
        }
    }

    // MARK: - Logging

    /// Adds a breadcrumb log message sent with subsequent crash and non-fatal reports.
    public func log(_ msg: String) {
        let ts = clockMillis()
        stateLock.withLock {
            if _breadcrumbs.count >= Self.maxBreadcrumbs {
                _breadcrumbs.removeFirst()
            }
            _breadcrumbs.append(CrashlyticsBreadcrumbEntry(message: msg, timestampMs: ts))
        }
        var params = baseParams()
        params["message"] = .string(msg)
        params["timestampMs"] = .int(ts)
        enqueueFireAndForgetOp(method: "crashlytics.log", params: params)
    }

    /// Adds a formatted breadcrumb log message using variadic `CVarArg` arguments.
    public func log(format: String, _ args: any CVarArg...) {
        let formatted = withVaList(args) { ptr in
            NSString(format: format, arguments: ptr) as String
        }
        log(formatted)
    }

    /// Adds a formatted breadcrumb log message using a `CVaListPointer`.
    public func log(format: String, arguments args: CVaListPointer) {
        let formatted = NSString(format: format, arguments: args) as String
        log(formatted)
    }

    // MARK: - Custom Keys & User ID

    /// Sets or removes (`nil`) a custom key-value pair associated with subsequent reports.
    public func setCustomValue(_ value: Any?, forKey key: String) {
        let normalized = CrashlyticsValueNormalizer.normalizeCustomValue(value)
        var params = baseParams()
        params["keys"] = .dictionary([key: normalized])
        enqueueFireAndForgetOp(method: "crashlytics.setCustomKeys", params: params)
    }

    /// Sets or removes multiple custom key-value pairs associated with subsequent reports.
    public func setCustomKeysAndValues(_ keysAndValues: [AnyHashable: Any]) {
        var converted: [String: AnySendable] = [:]
        for (rawKey, rawValue) in keysAndValues {
            let key = (rawKey as? String) ?? String(describing: rawKey)
            converted[key] = CrashlyticsValueNormalizer.normalizeCustomValue(rawValue)
        }
        var params = baseParams()
        params["keys"] = .dictionary(converted)
        enqueueFireAndForgetOp(method: "crashlytics.setCustomKeys", params: params)
    }

    /// Associates a user identifier with subsequent fatal and non-fatal reports.
    public func setUserID(_ userID: String?) {
        var params = baseParams()
        params["userId"] = .string(userID ?? "")
        enqueueFireAndForgetOp(method: "crashlytics.setUserId", params: params)
    }

    // MARK: - Recording Errors & Exception Models

    /// Records a non-fatal error event.
    public func record(error: any Error) {
        record(error: error, userInfo: nil)
    }

    /// Records a non-fatal error event with per-report `userInfo` attributes.
    public func record(error: any Error, userInfo: [String: Any]?) {
        let ts = clockMillis()
        let capturedStack = Thread.callStackSymbols
        let normalized = CrashlyticsValueNormalizer.normalizeError(
            error,
            extraUserInfo: userInfo,
            capturedStackSymbols: capturedStack
        )
        let (crumbs, deferred) = snapshotBreadcrumbsAndDeferredFlag()

        var params = baseParams()
        params["name"] = .string(normalized.name)
        params["message"] = .string(normalized.message)
        params["code"] = .string(normalized.code)
        if let stack = normalized.stack {
            params["stack"] = .string(stack)
        }
        if let cause = normalized.cause {
            params["cause"] = .string(cause)
        }
        params["fatal"] = .bool(false)
        if !normalized.attributes.isEmpty {
            params["attributes"] = .dictionary(normalized.attributes)
        }
        params["breadcrumbs"] = .array(crumbs.map { $0.toWire() })
        params["timestampMs"] = .int(ts)
        params["sdkPlatform"] = .string(Self.sdkPlatformIOS)
        if deferred {
            params["deferred"] = .bool(true)
        }
        enqueueFireAndForgetOp(method: "crashlytics.recordError", params: params)
    }

    /// Records a custom `ExceptionModel` and its `StackFrame` stack trace.
    public func record(exceptionModel: ExceptionModel) {
        let ts = clockMillis()
        let snap = exceptionModel.snapshot()
        let resolvedName = snap.name.isEmpty ? "ExceptionModel" : snap.name
        let formattedStack: String?
        if snap.stackTrace.isEmpty {
            formattedStack = nil
        } else {
            formattedStack = snap.stackTrace.map(\.description).joined(separator: "\n")
        }
        let (crumbs, deferred) = stateLock.withLock { () -> ([CrashlyticsBreadcrumbEntry], Bool) in
            if snap.isFatal {
                _didPreviouslyCrash = true
            }
            let isDeferred = !resolveCollectionEnabledLocked()
            return (_breadcrumbs, isDeferred)
        }

        var params = baseParams()
        params["name"] = .string(resolvedName)
        params["message"] = .string(snap.reason)
        if let formattedStack {
            params["stack"] = .string(formattedStack)
        }
        params["fatal"] = .bool(snap.isFatal)
        params["breadcrumbs"] = .array(crumbs.map { $0.toWire() })
        params["timestampMs"] = .int(ts)
        params["sdkPlatform"] = .string(Self.sdkPlatformIOS)
        if deferred {
            params["deferred"] = .bool(true)
        }
        enqueueFireAndForgetOp(method: "crashlytics.recordError", params: params)
    }

    private func adoptObservedAppBridge(_ nextClient: PyricBridgeClient) {
        stateLock.withLock {
            guard !_isDisposed, _ownedOverrideClient == nil else { return }
            _bridgeClient = nextClient
        }
    }
}
