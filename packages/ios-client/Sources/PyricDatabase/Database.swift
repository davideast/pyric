import Foundation
import PyricFirestore
import FirebaseAuth

/// Entry point for the Firebase Realtime Database Swift SDK.
public final class Database: NSObject, @unchecked Sendable {

    private struct InstanceKey: Hashable {
        let appName: String
        let url: String
    }

    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var instances: [InstanceKey: Database] = [:]

    public static func database() -> Database {
        return database(app: FirebaseApp.app(), url: "https://default.firebaseio.com")
    }

    public static func database(url: String) -> Database {
        return database(app: FirebaseApp.app(), url: url)
    }

    public static func database(app: FirebaseApp) -> Database {
        return database(app: app, url: "https://default.firebaseio.com")
    }

    public static func database(app: FirebaseApp, url: String) -> Database {
        registryLock.lock()
        defer { registryLock.unlock() }
        let key = InstanceKey(appName: app.name, url: url)
        if let existing = instances[key] {
            return existing
        }
        let created = Database(app: app, url: url)
        instances[key] = created
        return created
    }

    public static func reset() {
        registryLock.lock()
        defer { registryLock.unlock() }
        instances.removeAll()
    }

    // ── Properties ────────────────────────────────────────────────────────────

    public let app: FirebaseApp
    public let url: String
    public private(set) var bridgeClient: PyricBridgeClient

    private let stateLock = NSLock()
    private var _impersonatedLens: AuthLens?
    private var _credentialProvider: (any AuthCredentialProvider)?
    private var lensContinuations: [UUID: AsyncStream<AuthLens>.Continuation] = [:]
    private var authSyncTask: Task<Void, Never>?

    public var credentialProvider: (any AuthCredentialProvider)? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            if let explicit = _credentialProvider {
                return explicit
            }
            return AuthCredentialProviderRegistry.resolve(app: app)
        }
        set {
            stateLock.lock()
            _credentialProvider = newValue
            stateLock.unlock()
            startAuthLensSync()
        }
    }

    public init(app: FirebaseApp, url: String, bridgeClient: PyricBridgeClient? = nil) {
        self.app = app
        self.url = url
        self.bridgeClient = bridgeClient ?? Firestore.firestore(app: app).bridgeClient
        super.init()
        startAuthLensSync()
    }

    deinit {
        authSyncTask?.cancel()
    }

    private func startAuthLensSync() {
        authSyncTask?.cancel()
        guard let provider = credentialProvider else { return }
        authSyncTask = Task { [weak self] in
            for await _ in provider.authLensStream {
                guard !Task.isCancelled, let self else { break }
                self.notifyLensChanged()
            }
        }
    }

    public func switchLens(_ lens: AuthLens?) {
        stateLock.lock()
        _impersonatedLens = lens
        stateLock.unlock()
        notifyLensChanged()
    }

    private func notifyLensChanged() {
        let current = currentAuthLens()
        stateLock.lock()
        let conts = Array(lensContinuations.values)
        stateLock.unlock()
        for cont in conts {
            cont.yield(current)
        }
    }

    public func currentAuthLens() -> AuthLens {
        stateLock.lock()
        let overrideLens = _impersonatedLens
        stateLock.unlock()
        if let overrideLens {
            return overrideLens
        }
        if let provider = credentialProvider {
            return provider.currentAuthLens()
        }
        return .anon
    }

    public var authLensStream: AsyncStream<AuthLens> {
        if authSyncTask == nil {
            startAuthLensSync()
        }
        return AsyncStream { continuation in
            let id = UUID()
            let initial = self.currentAuthLens()
            stateLock.lock()
            lensContinuations[id] = continuation
            stateLock.unlock()
            continuation.yield(initial)

            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.stateLock.lock()
                self.lensContinuations.removeValue(forKey: id)
                self.stateLock.unlock()
            }
        }
    }

    // ── DatabaseReferences ────────────────────────────────────────────────────

    public func reference() -> DatabaseReference {
        return DatabaseReference(database: self, path: "/")
    }

    public func reference(withPath path: String) -> DatabaseReference {
        return DatabaseReference(database: self, path: path)
    }

    public func reference(fromURL databaseUrl: String) -> DatabaseReference {
        if let parsed = URL(string: databaseUrl) {
            return DatabaseReference(database: self, path: parsed.path.isEmpty ? "/" : parsed.path)
        }
        return DatabaseReference(database: self, path: "/")
    }

    // ── Connection Control ────────────────────────────────────────────────────

    public func goOffline() async throws {
        _ = try await bridgeClient.op(
            method: "rtdb.goOffline",
            params: [:],
            actAs: currentAuthLens()
        )
    }

    public func goOffline() {
        Task {
            try? await goOffline()
        }
    }

    public func goOnline() async throws {
        _ = try await bridgeClient.op(
            method: "rtdb.goOnline",
            params: [:],
            actAs: currentAuthLens()
        )
    }

    public func goOnline() {
        Task {
            try? await goOnline()
        }
    }
}
