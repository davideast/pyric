import Foundation
import PyricFirestore

/// Internal bridge-backed attestation helper shared by the built-in Apple App Check providers.
final class BridgeAppCheckProviderCore: @unchecked Sendable {
    let app: FirebaseApp
    let providerKind: String

    init(app: FirebaseApp, providerKind: String) {
        self.app = app
        self.providerKind = providerKind
    }

    private var resolvedAppId: String? {
        let trimmed = app.options.googleAppID.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private var resolvedProjectId: String? {
        guard let raw = app.options.projectID else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func fetchToken(forcingRefresh: Bool) async throws -> AppCheckToken {
        let bridge = AppCheck.resolveBridgeClient(for: app)
        do {
            return try await bridge.appCheckGetToken(
                appId: resolvedAppId,
                projectId: resolvedProjectId,
                provider: providerKind,
                forcingRefresh: forcingRefresh
            )
        } catch {
            throw AppCheckError.from(error)
        }
    }

    func fetchLimitedUseToken() async throws -> AppCheckToken {
        let bridge = AppCheck.resolveBridgeClient(for: app)
        do {
            return try await bridge.appCheckGetLimitedUseToken(
                appId: resolvedAppId,
                projectId: resolvedProjectId,
                provider: providerKind
            )
        } catch {
            throw AppCheckError.from(error)
        }
    }

    func getToken(completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void) {
        Task {
            do {
                let minted = try await fetchToken(forcingRefresh: true)
                handler(minted, nil)
            } catch {
                handler(nil, AppCheckError.from(error))
            }
        }
    }

    func getLimitedUseToken(completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void) {
        Task {
            do {
                let minted = try await fetchLimitedUseToken()
                handler(minted, nil)
            } catch {
                handler(nil, AppCheckError.from(error))
            }
        }
    }
}

/// Debug App Check provider for simulator and local test environments,
/// mirroring `FIRAppCheckDebugProvider` (`AppCheckDebugProvider`).
public final class AppCheckDebugProvider: NSObject, AppCheckProvider, @unchecked Sendable {
    private static let tokenStoreLock = NSLock()
    nonisolated(unsafe) private static var localTokensByAppName: [String: String] = [:]

    private let core: BridgeAppCheckProviderCore
    private let environmentOverride: [String: String]?

    public convenience init?(app: FirebaseApp) {
        self.init(app: app, environment: nil)
    }

    package init?(app: FirebaseApp, environment: [String: String]?) {
        guard !app.options.googleAppID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        self.core = BridgeAppCheckProviderCore(app: app, providerKind: "debug")
        self.environmentOverride = environment
        super.init()
    }

    /// Returns the locally generated debug token for this app instance.
    public func localDebugToken() -> String {
        Self.tokenStoreLock.lock()
        defer { Self.tokenStoreLock.unlock() }
        if let existing = Self.localTokensByAppName[core.app.name] {
            return existing
        }
        let generated = UUID().uuidString
        Self.localTokensByAppName[core.app.name] = generated
        return generated
    }

    /// Returns the active debug token, prioritizing `AppCheckDebugToken` and `FIRAAppCheckDebugToken`.
    public func currentDebugToken() -> String {
        let env = environmentOverride ?? ProcessInfo.processInfo.environment
        if let primary = Self.nonEmpty(env["AppCheckDebugToken"]) {
            return primary
        }
        if let legacy = Self.nonEmpty(env["FIRAAppCheckDebugToken"]) {
            return legacy
        }
        return localDebugToken()
    }

    public func getToken(completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void) {
        core.getToken(completion: handler)
    }

    public func getLimitedUseToken(completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void) {
        core.getLimitedUseToken(completion: handler)
    }

    static func resetLocalTokens() {
        tokenStoreLock.lock()
        localTokensByAppName.removeAll()
        tokenStoreLock.unlock()
    }

    private static func nonEmpty(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}

/// Factory vending `AppCheckDebugProvider` instances,
/// mirroring `FIRAppCheckDebugProviderFactory` (`AppCheckDebugProviderFactory`).
public final class AppCheckDebugProviderFactory: NSObject, AppCheckProviderFactory, @unchecked Sendable {
    public override init() {
        super.init()
    }

    public func createProvider(with app: FirebaseApp) -> (any AppCheckProvider)? {
        AppCheckDebugProvider(app: app)
    }
}

/// App Check provider backed by Apple App Attest semantics via the Pyric bridge,
/// mirroring `FIRAppAttestProvider` (`AppAttestProvider`).
public final class AppAttestProvider: NSObject, AppCheckProvider, @unchecked Sendable {
    private let core: BridgeAppCheckProviderCore

    public init?(app: FirebaseApp) {
        guard !app.options.googleAppID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        self.core = BridgeAppCheckProviderCore(app: app, providerKind: "app-attest")
        super.init()
    }

    public func getToken(completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void) {
        core.getToken(completion: handler)
    }

    public func getLimitedUseToken(completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void) {
        core.getLimitedUseToken(completion: handler)
    }
}

/// Factory vending `AppAttestProvider` instances,
/// mirroring `FIRAppAttestProviderFactory` (`AppAttestProviderFactory`).
public final class AppAttestProviderFactory: NSObject, AppCheckProviderFactory, @unchecked Sendable {
    public override init() {
        super.init()
    }

    public func createProvider(with app: FirebaseApp) -> (any AppCheckProvider)? {
        AppAttestProvider(app: app)
    }
}

/// App Check provider backed by Apple DeviceCheck semantics via the Pyric bridge,
/// mirroring `FIRDeviceCheckProvider` (`DeviceCheckProvider`).
public final class DeviceCheckProvider: NSObject, AppCheckProvider, @unchecked Sendable {
    private let core: BridgeAppCheckProviderCore

    public init?(app: FirebaseApp) {
        guard !app.options.googleAppID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        self.core = BridgeAppCheckProviderCore(app: app, providerKind: "device-check")
        super.init()
    }

    public func getToken(completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void) {
        core.getToken(completion: handler)
    }

    public func getLimitedUseToken(completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void) {
        core.getLimitedUseToken(completion: handler)
    }
}

/// Factory vending `DeviceCheckProvider` instances,
/// mirroring `FIRDeviceCheckProviderFactory` (`DeviceCheckProviderFactory`).
public final class DeviceCheckProviderFactory: NSObject, AppCheckProviderFactory, @unchecked Sendable {
    public override init() {
        super.init()
    }

    public func createProvider(with app: FirebaseApp) -> (any AppCheckProvider)? {
        DeviceCheckProvider(app: app)
    }
}
