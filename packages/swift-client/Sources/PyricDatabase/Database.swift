import Foundation
import PyricFirestore
import FirebaseAuth
@_exported import class PyricFirestore.FirebaseApp
@_exported import class PyricFirestore.FirebaseOptions

/// Entry point for the Firebase Realtime Database Swift SDK.
public final class Database: NSObject, @unchecked Sendable {

    private struct InstanceKey: Hashable {
        let appName: String
        let canonicalInstance: String
    }

    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var instances: [InstanceKey: Database] = [:]

    public static func database() -> Database {
        return database(app: FirebaseApp.app())
    }

    public static func database(url: String) -> Database {
        return database(app: FirebaseApp.app(), url: url)
    }

    public static func database(app: FirebaseApp) -> Database {
        let configuredURL = app.options.databaseURL?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let effectiveURL: String
        if !configuredURL.isEmpty {
            effectiveURL = configuredURL
        } else if let rawProj = app.options.projectID?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !rawProj.isEmpty {
            effectiveURL = "https://\(rawProj)-default-rtdb.firebaseio.com"
        } else {
            effectiveURL = DatabaseInstanceResolver.defaultDatabaseURL
        }
        return database(app: app, url: effectiveURL)
    }

    public static func database(app: FirebaseApp, url: String) -> Database {
        let normalizedURL = DatabaseInstanceResolver.normalizeDatabaseURL(url)
        let canonical = DatabaseInstanceResolver.canonicalInstanceKey(
            from: normalizedURL,
            projectID: app.options.projectID
        )
        let key = InstanceKey(appName: app.name, canonicalInstance: canonical)
        var evictedStale: Database?
        registryLock.lock()
        if let existing = instances[key] {
            if existing.app === app {
                registryLock.unlock()
                return existing
            }
            evictedStale = existing
        }
        let created = Database(app: app, url: normalizedURL)
        instances[key] = created
        registryLock.unlock()
        evictedStale?.detachBridgeObserver()
        return created
    }

    public static func reset() {
        let evicted: [Database] = {
            registryLock.lock()
            defer { registryLock.unlock() }
            let all = Array(instances.values)
            instances.removeAll()
            return all
        }()
        for db in evicted {
            db.detachBridgeObserver()
        }
    }

    // -- Properties --

    public let app: FirebaseApp
    public let url: String
    internal let wireInstance: String?
    internal let viewCoordinator = DatabaseViewCoordinator()
    internal let connectionInfoHub: ConnectionInfoHub
    private let usesAppBridge: Bool

    private let stateLock = NSLock()
    private var _bridgeClient: PyricBridgeClient
    private var bridgeObserverID: UUID?
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
            let explicit: (any AuthCredentialProvider)? = {
                stateLock.lock()
                defer { stateLock.unlock() }
                return _credentialProvider
            }()
            if let explicit {
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
        let resolvedClient = bridgeClient ?? app.sharedBridgeClient()
        self._bridgeClient = resolvedClient
        self.connectionInfoHub = ConnectionInfoHub(bridgeClient: resolvedClient, networkOnline: true)
        self.wireInstance = DatabaseInstanceResolver.resolveInstanceName(
            from: normalizedURL,
            projectID: app.options.projectID
        )
        super.init()
        if usesAppBridge {
            self.bridgeObserverID = app.addBridgeObserver { [weak self] nextClient in
                self?.adoptObservedAppBridge(nextClient)
            }
        } else {
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
                let sharedClient = app.sharedBridgeClient()
                adoptBridgeClient(sharedClient, emulatorHostPort: targetHostPort)
            }
            return
        }

        precondition(!alreadyUsed, "Cannot call useEmulator(withHost:port:) after Database has been used.")

        if usesAppBridge {
            let sharedClient = app.useEmulator(withHost: cleanHost, port: port, sslEnabled: false)
            adoptBridgeClient(sharedClient, emulatorHostPort: targetHostPort)
            Self.propagateAppBridge(
                appName: app.name,
                client: sharedClient,
                emulatorHostPort: targetHostPort,
                excluding: self
            )
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

    private func adoptObservedAppBridge(_ client: PyricBridgeClient) {
        stateLock.lock()
        _bridgeClient = client
        stateLock.unlock()
        connectionInfoHub.attach(to: client)
    }

    private func adoptBridgeClient(_ client: PyricBridgeClient, emulatorHostPort: String?) {
        stateLock.lock()
        _bridgeClient = client
        if let emulatorHostPort {
            _emulatorHostAndPort = emulatorHostPort
        }
        stateLock.unlock()
        connectionInfoHub.attach(to: client)
    }

    private static func propagateAppBridge(
        appName: String,
        client: PyricBridgeClient,
        emulatorHostPort: String,
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
            sibling._bridgeClient = client
            sibling._emulatorHostAndPort = emulatorHostPort
            sibling.stateLock.unlock()
            sibling.connectionInfoHub.attach(to: client)
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

    internal func detachBridgeObserver() {
        viewCoordinator.shutdown()
        connectionInfoHub.detach()
        let idToRemove: UUID? = {
            stateLock.lock()
            defer { stateLock.unlock() }
            let id = bridgeObserverID
            bridgeObserverID = nil
            return id
        }()
        if let idToRemove {
            app.removeBridgeObserver(idToRemove)
        }
    }

    deinit {
        viewCoordinator.shutdown()
        authSyncTask?.cancel()
        detachBridgeObserver()
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
            emulatorHost: emulatorHostAndPort,
            projectID: app.options.projectID
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
        guard _networkOnline != online else {
            stateLock.unlock()
            return
        }
        _networkOnline = online
        for continuation in networkContinuations.values { continuation.yield(online) }
        stateLock.unlock()
        connectionInfoHub.updateNetworkOnline(online)
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
