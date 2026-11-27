import Foundation
import PyricFirestore

extension Notification.Name {
    /// Posted to `NotificationCenter.default` whenever a Firebase App Check token is refreshed.
    public static let AppCheckTokenDidChange = Notification.Name(
        "FIRAppCheckAppCheckTokenDidChangeNotification"
    )
}

/// Convenience constant matching Objective-C `FIRAppCheckAppCheckTokenDidChangeNotification`.
public let AppCheckTokenDidChangeNotification = Notification.Name.AppCheckTokenDidChange

/// `userInfo` key for the refreshed JWT string in `Notification.Name.AppCheckTokenDidChange`.
public let AppCheckTokenNotificationKey = "FIRAppCheckTokenNotificationKey"

/// `userInfo` key for `FirebaseApp.name` in `Notification.Name.AppCheckTokenDidChange`.
public let AppCheckAppNameNotificationKey = "FIRAppCheckAppNameNotificationKey"

/// Manages Firebase App Check tokens for a `FirebaseApp`, mirroring `FIRAppCheck` (`AppCheck`).
public final class AppCheck: NSObject, @unchecked Sendable {
    static let placeholderToken = "eyJlcnJvciI6IlVOS05PV05fRVJST1IifQ=="
    private static let autoRefreshBufferSeconds: TimeInterval = 300.0
    private static let minAutoRefreshDelaySeconds: TimeInterval = 0.05
    private static let maxAutoRefreshDelaySeconds: TimeInterval = 86_400.0 * 365.0

    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var instances: [String: AppCheck] = [:]
    nonisolated(unsafe) private static var registeredFactory: (any AppCheckProviderFactory)? =
        DeviceCheckProviderFactory()

    public let app: FirebaseApp

    public var bridgeClient: PyricBridgeClient {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _bridgeClient
    }

    public var isTokenAutoRefreshEnabled: Bool {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _isTokenAutoRefreshEnabled
        }
        set {
            stateLock.lock()
            _isTokenAutoRefreshEnabled = newValue
            scheduleAutoRefreshLocked()
            stateLock.unlock()
        }
    }

    private let stateLock = NSLock()
    private var _bridgeClient: PyricBridgeClient
    private let explicitBridgeClient: PyricBridgeClient?
    private var bridgeObserverId: UUID?
    private var bridgeTokenProviderId: UUID?
    private let notificationCenter: NotificationCenter
    private let clockNow: @Sendable () -> Date

    private var installedProvider: (any AppCheckProvider)?
    private var cachedToken: AppCheckToken?
    private var inFlightStandardMintId: UUID?
    private var inFlightStandardMintTask: Task<AppCheckToken, Error>?
    private var mintGeneration: UInt64 = 0
    private var autoRefreshTask: Task<Void, Never>?
    private var _isTokenAutoRefreshEnabled: Bool

    @available(*, unavailable, message: "Use AppCheck.appCheck() or AppCheck.appCheck(app:).")
    public override init() {
        fatalError("AppCheck cannot be initialized directly with init().")
    }

    package init(
        app: FirebaseApp,
        provider: (any AppCheckProvider)?,
        bridgeClient: PyricBridgeClient? = nil,
        notificationCenter: NotificationCenter = .default,
        isTokenAutoRefreshEnabled: Bool = true,
        clockNow: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.app = app
        self.installedProvider = provider
        self.explicitBridgeClient = bridgeClient
        self._bridgeClient = bridgeClient ?? app.sharedBridgeClient()
        self.notificationCenter = notificationCenter
        self._isTokenAutoRefreshEnabled = isTokenAutoRefreshEnabled
        self.clockNow = clockNow
        super.init()

        if provider != nil {
            self.installBridgeTokenProvider(on: self._bridgeClient)
        }
        if bridgeClient == nil {
            self.bridgeObserverId = app.addBridgeObserver { [weak self] nextClient in
                self?.applySharedBridgeClient(nextClient)
            }
        }
    }

    // MARK: - Static Factory & Provider Registration

    /// Sets the `AppCheckProviderFactory` used to create `AppCheckProvider` instances.
    /// Call before `FirebaseApp.configure()` / `AppCheck.appCheck(app:)`.
    public static func setAppCheckProviderFactory(_ factory: (any AppCheckProviderFactory)?) {
        registryLock.lock()
        registeredFactory = factory
        registryLock.unlock()
    }

    /// Returns the currently registered `AppCheckProviderFactory`, if any.
    public static var providerFactory: (any AppCheckProviderFactory)? {
        registryLock.lock()
        defer { registryLock.unlock() }
        return registeredFactory
    }

    /// Returns the default `AppCheck` instance associated with `FirebaseApp.app()`.
    public static func appCheck() -> AppCheck {
        let defaultApp = FirebaseApp.app()
        if let resolved = appCheck(app: defaultApp) {
            return resolved
        }
        return getOrCreateUnconfiguredDefault(app: defaultApp)
    }

    /// Returns the `AppCheck` instance for `firebaseApp`, or `nil` when no provider factory
    /// is configured or the factory returns `nil` for `firebaseApp`.
    public static func appCheck(app firebaseApp: FirebaseApp) -> AppCheck? {
        var evicted: AppCheck?
        let resolved: AppCheck? = {
            registryLock.lock()
            defer { registryLock.unlock() }
            if let existing = instances[firebaseApp.name] {
                if existing.app === firebaseApp {
                    return existing
                }
                evicted = existing
                instances.removeValue(forKey: firebaseApp.name)
            }
            guard let factory = registeredFactory,
                  let provider = factory.createProvider(with: firebaseApp) else {
                return nil
            }
            let created = AppCheck(
                app: firebaseApp,
                provider: provider,
                isTokenAutoRefreshEnabled: defaultAutoRefreshSetting()
            )
            instances[firebaseApp.name] = created
            return created
        }()
        evicted?.dispose()
        return resolved
    }

    /// Returns or creates an `AppCheck` instance bound to an explicit `PyricBridgeClient`.
    public static func appCheck(
        app firebaseApp: FirebaseApp,
        bridgeClient: PyricBridgeClient
    ) -> AppCheck {
        var evicted: AppCheck?
        let resolved: AppCheck = {
            registryLock.lock()
            defer { registryLock.unlock() }
            if let existing = instances[firebaseApp.name] {
                if existing.app === firebaseApp && existing.explicitBridgeClient === bridgeClient {
                    return existing
                }
                evicted = existing
                instances.removeValue(forKey: firebaseApp.name)
            }
            let provider = registeredFactory?.createProvider(with: firebaseApp)
            let created = AppCheck(
                app: firebaseApp,
                provider: provider,
                bridgeClient: bridgeClient,
                isTokenAutoRefreshEnabled: defaultAutoRefreshSetting()
            )
            instances[firebaseApp.name] = created
            return created
        }()
        evicted?.dispose()
        return resolved
    }

    /// Resets all cached `AppCheck` instances and restores the default provider factory.
    public static func reset() {
        let evicted: [AppCheck] = {
            registryLock.lock()
            defer { registryLock.unlock() }
            let current = Array(instances.values)
            instances.removeAll()
            registeredFactory = DeviceCheckProviderFactory()
            return current
        }()
        for instance in evicted {
            instance.dispose()
        }
        AppCheckDebugProvider.resetLocalTokens()
    }

    package static func createForTesting(
        app firebaseApp: FirebaseApp,
        providerFactory: (any AppCheckProviderFactory)?,
        bridgeClient: PyricBridgeClient? = nil,
        notificationCenter: NotificationCenter = .default,
        isTokenAutoRefreshEnabled: Bool = true,
        clockNow: @escaping @Sendable () -> Date = { Date() }
    ) -> AppCheck {
        var evicted: AppCheck?
        let created: AppCheck = {
            registryLock.lock()
            defer { registryLock.unlock() }
            evicted = instances.removeValue(forKey: firebaseApp.name)
            let provider = providerFactory?.createProvider(with: firebaseApp)
            let next = AppCheck(
                app: firebaseApp,
                provider: provider,
                bridgeClient: bridgeClient,
                notificationCenter: notificationCenter,
                isTokenAutoRefreshEnabled: isTokenAutoRefreshEnabled,
                clockNow: clockNow
            )
            instances[firebaseApp.name] = next
            return next
        }()
        evicted?.dispose()
        return created
    }

    static func resolveBridgeClient(for app: FirebaseApp) -> PyricBridgeClient {
        registryLock.lock()
        let existing = instances[app.name]
        registryLock.unlock()
        if let existing, existing.app === app {
            return existing.bridgeClient
        }
        return app.sharedBridgeClient()
    }

    static func tokenForSharedRequest(app: FirebaseApp) async -> String? {
        let instance: AppCheck? = {
            registryLock.lock()
            defer { registryLock.unlock() }
            guard let candidate = instances[app.name], candidate.app === app else {
                return nil
            }
            return candidate
        }()
        guard let instance, instance.hasInstalledProvider else {
            return nil
        }
        do {
            return try await instance.token(forcingRefresh: false).token
        } catch {
            return placeholderToken
        }
    }

    // MARK: - Token Retrieval

    /// Requests a Firebase App Check token, returning a valid cached token when `forcingRefresh` is `false`.
    public func token(forcingRefresh: Bool) async throws -> AppCheckToken {
        try await getOrMintStandardToken(forcingRefresh: forcingRefresh)
    }

    /// Completion-handler overload of `token(forcingRefresh:)`.
    public func token(
        forcingRefresh: Bool,
        completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void
    ) {
        Task {
            do {
                let resolved = try await self.getOrMintStandardToken(forcingRefresh: forcingRefresh)
                handler(resolved, nil)
            } catch {
                handler(nil, AppCheckError.from(error) as NSError)
            }
        }
    }

    /// Requests a short-lived limited-use App Check token without mutating the standard token cache.
    public func limitedUseToken() async throws -> AppCheckToken {
        let provider = try requireInstalledProvider()
        do {
            return try await provider.getLimitedUseToken()
        } catch {
            throw AppCheckError.from(error)
        }
    }

    /// Completion-handler overload of `limitedUseToken()`.
    public func limitedUseToken(
        completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void
    ) {
        Task {
            do {
                let minted = try await self.limitedUseToken()
                handler(minted, nil)
            } catch {
                handler(nil, AppCheckError.from(error) as NSError)
            }
        }
    }

    // MARK: - Internal Lifecycle & Caching

    private var hasInstalledProvider: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return installedProvider != nil
    }

    private func requireInstalledProvider() throws -> any AppCheckProvider {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard let provider = installedProvider else {
            throw AppCheckError(
                code: .invalidConfiguration,
                message: "No AppCheckProvider installed for FirebaseApp '\(app.name)'."
            )
        }
        return provider
    }

    private func getOrMintStandardToken(forcingRefresh: Bool) async throws -> AppCheckToken {
        let action: MintAction = try {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard let provider = installedProvider else {
                throw AppCheckError(
                    code: .invalidConfiguration,
                    message: "No AppCheckProvider installed for FirebaseApp '\(app.name)'."
                )
            }
            if !forcingRefresh {
                if let current = cachedToken, isValidLocked(current) {
                    return .cached(current)
                }
                if let existingTask = inFlightStandardMintTask {
                    return .join(existingTask)
                }
                let mintId = UUID()
                mintGeneration &+= 1
                let capturedGeneration = mintGeneration
                let providerBox = UnsafeProviderBox(provider: provider)
                let task = Task<AppCheckToken, Error> { [weak self] in
                    let minted = try await providerBox.provider.getToken()
                    if let self {
                        self.completeStandardMint(
                            mintId: mintId,
                            generation: capturedGeneration,
                            provider: providerBox.provider,
                            minted: minted
                        )
                    }
                    return minted
                }
                inFlightStandardMintId = mintId
                inFlightStandardMintTask = task
                return .awaitOwned(mintId: mintId, task: task)
            }

            let mintId = UUID()
            mintGeneration &+= 1
            let capturedGeneration = mintGeneration
            let providerBox = UnsafeProviderBox(provider: provider)
            let task = Task<AppCheckToken, Error> { [weak self] in
                let minted = try await providerBox.provider.getToken()
                if let self {
                    self.completeStandardMint(
                        mintId: mintId,
                        generation: capturedGeneration,
                        provider: providerBox.provider,
                        minted: minted
                    )
                }
                return minted
            }
            return .awaitForced(task: task)
        }()

        switch action {
        case .cached(let valid):
            return valid
        case .join(let task):
            do {
                return try await task.value
            } catch {
                throw AppCheckError.from(error)
            }
        case .awaitOwned(let mintId, let task):
            do {
                return try await task.value
            } catch {
                clearInFlightMint(mintId: mintId)
                throw AppCheckError.from(error)
            }
        case .awaitForced(let task):
            do {
                return try await task.value
            } catch {
                throw AppCheckError.from(error)
            }
        }
    }

    private func completeStandardMint(
        mintId: UUID,
        generation: UInt64,
        provider: any AppCheckProvider,
        minted: AppCheckToken
    ) {
        let shouldPostNotification: Bool = {
            stateLock.lock()
            defer { stateLock.unlock() }
            if inFlightStandardMintId == mintId {
                inFlightStandardMintId = nil
                inFlightStandardMintTask = nil
            }
            guard mintGeneration == generation,
                  let activeProvider = installedProvider,
                  (activeProvider as AnyObject) === (provider as AnyObject) else {
                return false
            }
            let previousToken = cachedToken?.token
            cachedToken = minted
            scheduleAutoRefreshLocked()
            return previousToken != minted.token
        }()

        if shouldPostNotification {
            notificationCenter.post(
                name: .AppCheckTokenDidChange,
                object: self,
                userInfo: [
                    AppCheckTokenNotificationKey: minted.token,
                    AppCheckAppNameNotificationKey: app.name
                ]
            )
        }
    }

    private func clearInFlightMint(mintId: UUID) {
        stateLock.lock()
        if inFlightStandardMintId == mintId {
            inFlightStandardMintId = nil
            inFlightStandardMintTask = nil
        }
        stateLock.unlock()
    }

    private func isValidLocked(_ token: AppCheckToken) -> Bool {
        token.expirationDate.timeIntervalSince(clockNow()) > 0
    }

    private func scheduleAutoRefreshLocked() {
        autoRefreshTask?.cancel()
        autoRefreshTask = nil
        guard _isTokenAutoRefreshEnabled,
              installedProvider != nil,
              let current = cachedToken else {
            return
        }
        let rawRemaining = current.expirationDate.timeIntervalSince(clockNow())
        guard rawRemaining > 0 else {
            return
        }
        let remaining = rawRemaining.isFinite ? rawRemaining : Self.maxAutoRefreshDelaySeconds
        let lead = min(remaining / 2.0, Self.autoRefreshBufferSeconds)
        let delaySeconds = min(
            max(remaining - lead, Self.minAutoRefreshDelaySeconds),
            Self.maxAutoRefreshDelaySeconds
        )
        let sleepNanoseconds = UInt64((delaySeconds * 1_000_000_000.0).rounded())

        autoRefreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: sleepNanoseconds)
            guard !Task.isCancelled, let self else {
                return
            }
            let shouldRefresh: Bool = {
                self.stateLock.lock()
                defer { self.stateLock.unlock() }
                return self._isTokenAutoRefreshEnabled && self.installedProvider != nil
            }()
            if shouldRefresh {
                _ = try? await self.getOrMintStandardToken(forcingRefresh: true)
            }
        }
    }

    private func installBridgeTokenProvider(on client: PyricBridgeClient) {
        let regId = client.setAppCheckTokenProvider { [weak self] in
            guard let self, self.hasInstalledProvider else { return nil }
            do {
                return try await self.token(forcingRefresh: false).token
            } catch {
                return Self.placeholderToken
            }
        }
        stateLock.lock()
        let keep = (_bridgeClient === client && installedProvider != nil)
        if keep { bridgeTokenProviderId = regId }
        stateLock.unlock()
        if !keep, let regId { client.clearAppCheckTokenProvider(id: regId) }
    }

    private func applySharedBridgeClient(_ nextClient: PyricBridgeClient) {
        let (prev, prevTokenId, shouldInstall): (PyricBridgeClient, UUID?, Bool) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            let previous = _bridgeClient
            let changed = previous !== nextClient
            let tokenId = changed ? bridgeTokenProviderId : nil
            if changed { bridgeTokenProviderId = nil }
            _bridgeClient = nextClient
            return (previous, tokenId, installedProvider != nil && (changed || bridgeTokenProviderId == nil))
        }()
        if let prevTokenId { prev.clearAppCheckTokenProvider(id: prevTokenId) }
        if shouldInstall { installBridgeTokenProvider(on: nextClient) }
    }

    private func dispose() {
        let (observerId, tokenId, currentClient): (UUID?, UUID?, PyricBridgeClient) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            mintGeneration &+= 1
            autoRefreshTask?.cancel()
            autoRefreshTask = nil
            inFlightStandardMintTask?.cancel()
            inFlightStandardMintTask = nil
            inFlightStandardMintId = nil
            cachedToken = nil
            installedProvider = nil
            let id = bridgeObserverId
            bridgeObserverId = nil
            let tokId = bridgeTokenProviderId
            bridgeTokenProviderId = nil
            return (id, tokId, _bridgeClient)
        }()
        if let tokenId { currentClient.clearAppCheckTokenProvider(id: tokenId) }
        if let observerId { app.removeBridgeObserver(observerId) }
    }

    private static func getOrCreateUnconfiguredDefault(app: FirebaseApp) -> AppCheck {
        registryLock.lock()
        defer { registryLock.unlock() }
        if let existing = instances[app.name], existing.app === app {
            return existing
        }
        let created = AppCheck(
            app: app,
            provider: nil,
            isTokenAutoRefreshEnabled: defaultAutoRefreshSetting()
        )
        instances[app.name] = created
        return created
    }

    private static func defaultAutoRefreshSetting() -> Bool {
        if let configured = Bundle.main.object(
            forInfoDictionaryKey: "FirebaseAppCheckTokenAutoRefreshEnabled"
        ) as? Bool {
            return configured
        }
        return true
    }

    private enum MintAction {
        case cached(AppCheckToken)
        case join(Task<AppCheckToken, Error>)
        case awaitOwned(mintId: UUID, task: Task<AppCheckToken, Error>)
        case awaitForced(task: Task<AppCheckToken, Error>)
    }
}

private struct UnsafeProviderBox: @unchecked Sendable {
    let provider: any AppCheckProvider
}
