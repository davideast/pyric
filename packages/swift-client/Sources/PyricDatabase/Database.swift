import Foundation
import PyricFirestore
import FirebaseAuth

/// Entry point for the Firebase Realtime Database Swift SDK.
public final class Database: NSObject, @unchecked Sendable {

    private struct InstanceKey: Hashable {
        let appName: String
        let canonicalInstance: String
    }

    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var instances: [InstanceKey: Database] = [:]

    public static func database() -> Database {
        return database(app: FirebaseApp.app(), url: DatabaseInstanceResolver.defaultDatabaseURL)
    }

    public static func database(url: String) -> Database {
        return database(app: FirebaseApp.app(), url: url)
    }

    public static func database(app: FirebaseApp) -> Database {
        return database(app: app, url: DatabaseInstanceResolver.defaultDatabaseURL)
    }

    public static func database(app: FirebaseApp, url: String) -> Database {
        let normalizedURL = DatabaseInstanceResolver.normalizeDatabaseURL(url)
        let canonical = DatabaseInstanceResolver.canonicalInstanceKey(from: normalizedURL)
        registryLock.lock()
        defer { registryLock.unlock() }
        let key = InstanceKey(appName: app.name, canonicalInstance: canonical)
        if let existing = instances[key] {
            return existing
        }
        let created = Database(app: app, url: normalizedURL)
        instances[key] = created
        return created
    }

    public static func reset() {
        registryLock.lock()
        defer { registryLock.unlock() }
        instances.removeAll()
    }

    // -- Properties --

    public let app: FirebaseApp
    public let url: String
    internal let wireInstance: String?
    private let usesAppBridge: Bool

    private let stateLock = NSLock()
    private var _bridgeClient: PyricBridgeClient
    private var _emulatorHostAndPort: String?
    private var _hasUsed = false
    private var _impersonatedLens: AuthLens?
    private var _credentialProvider: (any AuthCredentialProvider)?
    private var lensContinuations: [UUID: AsyncStream<AuthLens>.Continuation] = [:]
    private var authSyncTask: Task<Void, Never>?
    private var _networkOnline = true
    private var networkContinuations: [UUID: AsyncStream<Bool>.Continuation] = [:]

    public var bridgeClient: PyricBridgeClient {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _bridgeClient
    }

    internal var emulatorHostAndPort: String? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _emulatorHostAndPort
    }

    internal func markUsed() {
        stateLock.lock()
        _hasUsed = true
        stateLock.unlock()
    }

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
        let normalizedURL = DatabaseInstanceResolver.normalizeDatabaseURL(url)
        self.app = app
        self.url = normalizedURL
        self.usesAppBridge = (bridgeClient == nil)
        self._bridgeClient = bridgeClient ?? Firestore.firestore(app: app).bridgeClient
        self.wireInstance = DatabaseInstanceResolver.resolveInstanceName(from: normalizedURL)
        super.init()
        if bridgeClient != nil {
            startAuthLensSync()
        }
    }

    // -- Emulator Configuration --

    public func useEmulator(withHost host: String, port: Int) {
        let cleanHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        precondition(!cleanHost.isEmpty && port > 0 && port <= 65535, "Invalid emulator host or port.")
        let targetHostPort = "\(cleanHost):\(port)"

        stateLock.lock()
        let currentEmulator = _emulatorHostAndPort
        let alreadyUsed = _hasUsed
        stateLock.unlock()

        if currentEmulator == targetHostPort {
            if usesAppBridge {
                let fsClient = Firestore.firestore(app: app).bridgeClient
                adoptBridgeClient(fsClient, emulatorHostPort: targetHostPort)
            }
            return
        }

        precondition(!alreadyUsed, "Cannot call useEmulator(withHost:port:) after Database has been used.")

        if usesAppBridge {
            let fs = Firestore.firestore(app: app)
            if fs.settings.host != targetHostPort || fs.settings.sslEnabled {
                fs.useEmulator(host: cleanHost, port: port)
            }
            let sharedClient = fs.bridgeClient
            adoptBridgeClient(sharedClient, emulatorHostPort: targetHostPort)
            Self.propagateAppBridge(appName: app.name, client: sharedClient, excluding: self)
        } else {
            guard let endpoint = URL(string: "ws://\(targetHostPort)/__pyric/sandbox") else {
                preconditionFailure("Invalid emulator endpoint for \(targetHostPort).")
            }
            let standalone = PyricBridgeClient(
                endpoint: endpoint,
                headers: ["Host": targetHostPort]
            )
            adoptBridgeClient(standalone, emulatorHostPort: targetHostPort)
        }
    }

    private func adoptBridgeClient(_ client: PyricBridgeClient, emulatorHostPort: String?) {
        stateLock.lock()
        _bridgeClient = client
        if let emulatorHostPort {
            _emulatorHostAndPort = emulatorHostPort
        }
        stateLock.unlock()
    }

    private static func propagateAppBridge(
        appName: String,
        client: PyricBridgeClient,
        excluding caller: Database
    ) {
        let siblings: [Database] = {
            registryLock.lock()
            defer { registryLock.unlock() }
            return instances.compactMap { key, db in
                guard key.appName == appName, db !== caller, db.usesAppBridge else {
                    return nil
                }
                return db
            }
        }()
        for sibling in siblings {
            sibling.stateLock.lock()
            if !sibling._hasUsed {
                sibling._bridgeClient = client
            }
            sibling.stateLock.unlock()
        }
    }

    internal func withInstance(_ params: [String: AnySendable]) -> [String: AnySendable] {
        guard let instance = wireInstance else {
            return params
        }
        var out = params
        out["instance"] = .string(instance)
        return out
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

    // -- DatabaseReferences --

    public func reference() -> DatabaseReference {
        return DatabaseReference(database: self, path: "/")
    }

    public func reference(withPath path: String) -> DatabaseReference {
        return DatabaseReference(database: self, path: path)
    }

    public func reference(fromURL databaseUrl: String) -> DatabaseReference {
        do {
            return try validatedReference(fromURL: databaseUrl)
        } catch {
            preconditionFailure("InvalidDatabaseURL: \(error.localizedDescription)")
        }
    }

    package func validatedReference(fromURL databaseUrl: String) throws -> DatabaseReference {
        let validatedPath = try DatabaseInstanceResolver.validateReferenceURL(
            databaseUrl,
            databaseURL: url,
            emulatorHost: emulatorHostAndPort
        )
        return DatabaseReference(database: self, path: validatedPath)
    }

    // -- Connection Control --

    /// Whether `goOnline()` was the last connection call. `.info/connected`
    /// is false while this is off, whatever the bridge connection's state.
    internal var isNetworkOnline: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _networkOnline
    }

    /// The network flag, starting with its current value.
    internal var networkOnlineStream: AsyncStream<Bool> {
        AsyncStream { continuation in
            let id = UUID()
            stateLock.lock()
            networkContinuations[id] = continuation
            continuation.yield(_networkOnline)
            stateLock.unlock()

            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.stateLock.lock()
                self.networkContinuations.removeValue(forKey: id)
                self.stateLock.unlock()
            }
        }
    }

    private func setNetworkOnline(_ online: Bool) {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard _networkOnline != online else { return }
        _networkOnline = online
        for continuation in networkContinuations.values { continuation.yield(online) }
    }

    public func goOffline() async throws {
        markUsed()
        setNetworkOnline(false)
        try await send(turn: takeTurn(), method: "rtdb.goOffline", params: [:])
    }

    public func goOffline() {
        markUsed()
        setNetworkOnline(false)
        sendInCallOrder(method: "rtdb.goOffline", params: [:]) { _ in }
    }

    public func goOnline() async throws {
        markUsed()
        setNetworkOnline(true)
        try await send(turn: takeTurn(), method: "rtdb.goOnline", params: [:])
    }

    public func goOnline() {
        markUsed()
        setNetworkOnline(true)
        sendInCallOrder(method: "rtdb.goOnline", params: [:]) { _ in }
    }
}
