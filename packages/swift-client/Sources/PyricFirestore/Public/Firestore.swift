import Foundation

public final class FirebaseApp: @unchecked Sendable, Equatable {
    public let name: String

    private static let lock = NSLock()
    nonisolated(unsafe) private static var defaultAppInstance: FirebaseApp?

    public init(name: String = "[DEFAULT]") {
        self.name = name
    }

    public static func app() -> FirebaseApp {
        lock.lock()
        defer { lock.unlock() }
        if let existing = defaultAppInstance {
            return existing
        }
        let created = FirebaseApp(name: "[DEFAULT]")
        defaultAppInstance = created
        return created
    }

    public static func == (lhs: FirebaseApp, rhs: FirebaseApp) -> Bool {
        lhs.name == rhs.name
    }
}

public class Firestore: @unchecked Sendable {

    // ── Static Instance Registry ─────────────────────────────────────────────
    private struct InstanceKey: Hashable {
        let appName: String
        let database: String
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var instances: [InstanceKey: Firestore] = [:]

    nonisolated(unsafe) public static var shared: Firestore?

    public static func firestore() -> Firestore {
        lock.lock()
        if let shared {
            lock.unlock()
            return shared
        }
        lock.unlock()
        return firestore(app: FirebaseApp.app(), database: "(default)")
    }

    public static func firestore(app: FirebaseApp) -> Firestore {
        firestore(app: app, database: "(default)")
    }

    public static func firestore(database: String) -> Firestore {
        firestore(app: FirebaseApp.app(), database: database)
    }

    public static func firestore(app: FirebaseApp, database: String) -> Firestore {
        lock.lock()
        defer { lock.unlock() }
        let key = InstanceKey(appName: app.name, database: database)
        if let existing = instances[key] {
            return existing
        }
        let created = Firestore(app: app, database: database)
        instances[key] = created
        return created
    }

    // ── Instance Properties ──────────────────────────────────────────────────
    public let app: FirebaseApp
    public let database: String
    public var settings: FirestoreSettings {
        didSet {
            reconfigureBridge()
        }
    }

    public private(set) var bridgeClient: PyricBridgeClient

    private let instanceLock = NSLock()
    private var _credentialProvider: (any AuthCredentialProvider)?

    public var credentialProvider: (any AuthCredentialProvider)? {
        get {
            instanceLock.lock()
            defer { instanceLock.unlock() }
            if let explicit = _credentialProvider {
                return explicit
            }
            return AuthCredentialProviderRegistry.resolve(app: app)
        }
        set {
            instanceLock.lock()
            defer { instanceLock.unlock() }
            _credentialProvider = newValue
        }
    }

    public var effectiveAuthLens: AuthLens {
        credentialProvider?.currentAuthLens() ?? .anon
    }

    public var authLensStream: AsyncStream<AuthLens> {
        if let provider = credentialProvider {
            return provider.authLensStream
        }
        return AsyncStream { continuation in
            continuation.yield(.anon)
        }
    }

    private var hasUsed: Bool = false
    private var rulesDenialListeners: [UUID: @Sendable (PyricBridgeError) -> Void] = [:]
    private var denialObservationTask: Task<Void, Never>?

    /// Stream of Security Rules denial errors intercepted by the underlying bridge client.
    public var denialStream: AsyncStream<PyricBridgeError> {
        bridgeClient.denialStream
    }

    /// Registers a listener callback invoked whenever a Security Rules denial is intercepted.
    public func addRulesDenialListener(_ listener: @escaping @Sendable (PyricBridgeError) -> Void) -> ListenerRegistration {
        let id = UUID()
        instanceLock.lock()
        rulesDenialListeners[id] = listener
        startDenialObservationIfNeeded()
        instanceLock.unlock()

        return SimpleListenerRegistration { [weak self] in
            guard let self else { return }
            self.instanceLock.lock()
            self.rulesDenialListeners.removeValue(forKey: id)
            if self.rulesDenialListeners.isEmpty {
                self.denialObservationTask?.cancel()
                self.denialObservationTask = nil
            }
            self.instanceLock.unlock()
        }
    }

    private func currentRulesDenialListeners() -> [@Sendable (PyricBridgeError) -> Void] {
        instanceLock.lock()
        defer { instanceLock.unlock() }
        return Array(rulesDenialListeners.values)
    }

    private func startDenialObservationIfNeeded() {
        guard denialObservationTask == nil else { return }
        let stream = bridgeClient.denialStream
        denialObservationTask = Task { [weak self] in
            for await error in stream {
                guard !Task.isCancelled, let self else { break }
                let listeners = self.currentRulesDenialListeners()
                for listener in listeners {
                    self.settings.dispatchQueue.async {
                        listener(error)
                    }
                }
            }
        }
    }

    deinit {
        denialObservationTask?.cancel()
    }

    public init(bridgeClient: PyricBridgeClient, app: FirebaseApp = FirebaseApp.app(), database: String = "(default)") {
        self.app = app
        self.database = database
        self.settings = FirestoreSettings()
        self.bridgeClient = bridgeClient
    }

    public init(app: FirebaseApp = FirebaseApp.app(), database: String = "(default)") {
        self.app = app
        self.database = database
        let defaultSettings = FirestoreSettings()
        self.settings = defaultSettings
        let endpoint = URL(string: "ws://\(defaultSettings.host)/__pyric/sandbox")!
        self.bridgeClient = PyricBridgeClient(
            endpoint: endpoint,
            headers: ["Host": defaultSettings.host]
        )
    }

    private func reconfigureBridge() {
        let scheme = settings.sslEnabled ? "wss" : "ws"
        let endpoint = URL(string: "\(scheme)://\(settings.host)/__pyric/sandbox")!
        self.bridgeClient = PyricBridgeClient(
            endpoint: endpoint,
            headers: ["Host": settings.host]
        )
        instanceLock.lock()
        denialObservationTask?.cancel()
        denialObservationTask = nil
        if !rulesDenialListeners.isEmpty {
            startDenialObservationIfNeeded()
        }
        instanceLock.unlock()
    }

    private func markUsed() {
        hasUsed = true
    }

    // ── Configuration & Emulation ────────────────────────────────────

    public func useEmulator(host: String, port: Int) {
        precondition(!hasUsed, "Cannot call useEmulator after Firestore has been used.")
        settings.host = "\(host):\(port)"
        settings.sslEnabled = false
        reconfigureBridge()
    }

    // ── Document and Collection Accessors ────────────────────────────

    public func document(_ path: String) -> DocumentReference {
        markUsed()
        let clean = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let segments = clean.components(separatedBy: "/")
        precondition(
            !clean.isEmpty && segments.count % 2 == 0,
            "Invalid document reference. Document references must have an even number of segments, but '\(path)' has \(segments.count)."
        )
        return DocumentReference(firestore: self, path: clean)
    }

    public func collection(_ path: String) -> CollectionReference {
        markUsed()
        let clean = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let segments = clean.components(separatedBy: "/")
        precondition(
            !clean.isEmpty && segments.count % 2 == 1,
            "Invalid collection reference. Collection references must have an odd number of segments, but '\(path)' has \(segments.count)."
        )
        return CollectionReference(firestore: self, path: clean)
    }

    public func collectionGroup(_ collectionId: String) -> Query {
        markUsed()
        precondition(
            !collectionId.contains("/"),
            "Invalid collectionId '\(collectionId)'. Collection IDs must not contain '/'."
        )
        return Query(firestore: self, rootSource: .group(collectionId: collectionId))
    }

    // ── Batches and Transactions ─────────────────────────────────────

    public func batch() -> WriteBatch {
        markUsed()
        return WriteBatch(firestore: self)
    }

    public func runTransaction(
        _ updateBlock: @Sendable @escaping (Transaction) async throws -> Any?
    ) async throws -> Any? {
        try await runTransaction(options: TransactionOptions(), updateBlock)
    }

    public func runTransaction(
        options: TransactionOptions,
        _ updateBlock: @Sendable @escaping (Transaction) async throws -> Any?
    ) async throws -> Any? {
        markUsed()
        var attempts = 0
        let maxAttempts = max(1, options.maxAttempts)

        while attempts < maxAttempts {
            attempts += 1
            let txn = Transaction(firestore: self)
            do {
                let result = try await updateBlock(txn)
                try await bridgeClient.txnCommit(
                    reads: txn.stagedReads,
                    writes: txn.stagedWrites,
                    actAs: effectiveAuthLens
                )
                return result
            } catch let error as PyricBridgeError {
                if error.code == .aborted || error.code == .failedPrecondition {
                    if attempts >= maxAttempts {
                        throw error
                    }
                    let delayMs = min(1000, 50 * (1 << attempts)) + Int.random(in: 10...50)
                    try await Task.sleep(nanoseconds: UInt64(delayMs * 1_000_000))
                    continue
                }
                throw error
            } catch {
                throw error
            }
        }
        throw PyricBridgeError(code: .aborted, message: "Transaction failed after \(maxAttempts) attempts.")
    }

    public func runTransaction(
        _ updateBlock: @escaping @Sendable (Transaction, NSErrorPointer) -> Any?,
        completion: @escaping @Sendable (Any?, Error?) -> Void
    ) {
        runTransaction(options: nil, block: updateBlock, completion: completion)
    }

    public func runTransaction(
        options: TransactionOptions?,
        block updateBlock: @escaping @Sendable (Transaction, NSErrorPointer) -> Any?,
        completion: @escaping @Sendable (Any?, Error?) -> Void
    ) {
        let opts = options ?? TransactionOptions()
        Task {
            do {
                let result = try await self.runTransaction(options: opts) { txn in
                    var err: NSError?
                    let res = updateBlock(txn, &err)
                    if let err {
                        throw err
                    }
                    return res
                }
                self.settings.dispatchQueue.async {
                    completion(result, nil)
                }
            } catch {
                self.settings.dispatchQueue.async {
                    completion(nil, error)
                }
            }
        }
    }

    // ── Network & Cache Lifecycle ────────────────────────────────────

    public func enableNetwork() async throws {
        try await bridgeClient.connect()
    }

    public func enableNetwork(completion: (@Sendable (Error?) -> Void)? = nil) {
        Task {
            do {
                try await enableNetwork()
                settings.dispatchQueue.async { completion?(nil) }
            } catch {
                settings.dispatchQueue.async { completion?(error) }
            }
        }
    }

    public func disableNetwork() async throws {
        await bridgeClient.disconnect()
    }

    public func disableNetwork(completion: (@Sendable (Error?) -> Void)? = nil) {
        Task {
            do {
                try await disableNetwork()
                settings.dispatchQueue.async { completion?(nil) }
            } catch {
                settings.dispatchQueue.async { completion?(error) }
            }
        }
    }

    public func clearPersistence() async throws {
    }

    public func clearPersistence(completion: (@Sendable (Error?) -> Void)? = nil) {
        Task {
            do {
                try await clearPersistence()
                settings.dispatchQueue.async { completion?(nil) }
            } catch {
                settings.dispatchQueue.async { completion?(error) }
            }
        }
    }

    public func terminate() async throws {
        await bridgeClient.disconnect()
    }

    public func terminate(completion: (@Sendable (Error?) -> Void)? = nil) {
        Task {
            do {
                try await terminate()
                settings.dispatchQueue.async { completion?(nil) }
            } catch {
                settings.dispatchQueue.async { completion?(error) }
            }
        }
    }

    public func waitForPendingWrites() async throws {
    }

    public func waitForPendingWrites(completion: (@Sendable (Error?) -> Void)? = nil) {
        Task {
            do {
                try await waitForPendingWrites()
                settings.dispatchQueue.async { completion?(nil) }
            } catch {
                settings.dispatchQueue.async { completion?(error) }
            }
        }
    }

    public func addSnapshotsInSyncListener(_ listener: @escaping @Sendable () -> Void) -> ListenerRegistration {
        let reg = SimpleListenerRegistration { }
        settings.dispatchQueue.async { listener() }
        return reg
    }
}
