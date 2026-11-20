import Foundation

private struct TransactionCallbackResult: @unchecked Sendable {
    let value: Any?
}

public class Firestore: @unchecked Sendable {

    // -- Static Instance Registry --
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
        if let existing = instances[key], existing.app === app, !existing.lifecycle.isTerminated {
            return existing
        }
        let created = Firestore(app: app, database: database)
        instances[key] = created
        return created
    }

    public static func reset() {
        lock.lock()
        instances.removeAll()
        shared = nil
        lock.unlock()
        FirestorePersistenceStore.shared.resetAll()
    }

    private func evictSelfFromRegistry() {
        Self.lock.lock()
        let key = InstanceKey(appName: app.name, database: database)
        if Self.instances[key] === self {
            Self.instances.removeValue(forKey: key)
        }
        if Self.shared === self {
            Self.shared = nil
        }
        Self.lock.unlock()
    }

    // -- Instance Properties --
    public let app: FirebaseApp
    public let database: String
    public var settings: FirestoreSettings {
        didSet {
            reconfigureBridge()
        }
    }

    internal let lifecycle: FirestoreClientLifecycle

    public var bridgeClient: PyricBridgeClient {
        instanceLock.lock()
        defer { instanceLock.unlock() }
        return _bridgeClient
    }

    private var _bridgeClient: PyricBridgeClient
    private let usesSharedAppBridge: Bool
    private var bridgeObserverId: UUID?
    private let instanceLock = NSLock()
    private var _credentialProvider: (any AuthCredentialProvider)?

    public var credentialProvider: (any AuthCredentialProvider)? {
        get {
            let explicit: (any AuthCredentialProvider)? = {
                instanceLock.lock()
                defer { instanceLock.unlock() }
                return _credentialProvider
            }()
            if let explicit {
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

    internal var hasUsed: Bool = false
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
        startDenialObservationIfNeededLocked()
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

    /// Starts observing `_bridgeClient.denialStream`. Caller must hold `instanceLock`.
    private func startDenialObservationIfNeededLocked() {
        guard denialObservationTask == nil else { return }
        let stream = _bridgeClient.denialStream
        denialObservationTask = Task { [weak self] in
            for await error in stream {
                guard !Task.isCancelled, let self else { break }
                let listeners = self.currentRulesDenialListeners()
                for listener in listeners {
                    self.settings.dispatchCallback {
                        listener(error)
                    }
                }
            }
        }
    }

    deinit {
        if let observerId = bridgeObserverId {
            app.removeBridgeObserver(observerId)
        }
        denialObservationTask?.cancel()
    }

    public init(bridgeClient: PyricBridgeClient, app: FirebaseApp = FirebaseApp.app(), database: String = "(default)") {
        self.app = app
        self.database = database
        self.settings = FirestoreSettings()
        self.lifecycle = FirestoreClientLifecycle(appName: app.name, database: database)
        self._bridgeClient = bridgeClient
        self.usesSharedAppBridge = false
    }

    public init(app: FirebaseApp = FirebaseApp.app(), database: String = "(default)") {
        self.app = app
        self.database = database
        let defaultSettings = FirestoreSettings()
        self.settings = defaultSettings
        self.lifecycle = FirestoreClientLifecycle(appName: app.name, database: database)
        self._bridgeClient = app.sharedBridgeClient()
        self.usesSharedAppBridge = true
        self.bridgeObserverId = app.addBridgeObserver { [weak self] nextClient in
            self?.applyBridgeClient(nextClient)
        }
    }

    private func applyBridgeClient(_ nextClient: PyricBridgeClient) {
        instanceLock.lock()
        _bridgeClient = nextClient
        denialObservationTask?.cancel()
        denialObservationTask = nil
        if !rulesDenialListeners.isEmpty {
            startDenialObservationIfNeededLocked()
        }
        instanceLock.unlock()
    }

    private func reconfigureBridge() {
        let resolved = FirebaseBridgeEndpointResolver.endpointFromHostSetting(
            settings.host,
            sslEnabled: settings.sslEnabled
        )
        if usesSharedAppBridge {
            _ = app.reconfigureSharedBridge(
                endpoint: resolved.endpoint,
                headers: ["Host": resolved.hostHeader]
            )
            return
        }
        let standalone = PyricBridgeClient(
            endpoint: resolved.endpoint,
            headers: ["Host": resolved.hostHeader]
        )
        applyBridgeClient(standalone)
    }

    internal func markUsed() {
        hasUsed = true
        lifecycle.markStarted()
    }

    // -- Configuration & Emulation --

    public func useEmulator(host: String, port: Int) {
        precondition(!hasUsed, "Cannot call useEmulator after Firestore has been used.")
        settings.host = "\(host):\(port)"
        settings.sslEnabled = false
        reconfigureBridge()
    }

    // -- Document and Collection Accessors --

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

    // -- Batches and Transactions --

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
        return try await runTransaction(turn: takeTurn(), options: options, updateBlock)
    }

    private func runTransaction(
        turn: OperationTurn,
        options: TransactionOptions,
        _ updateBlock: @Sendable @escaping (Transaction) async throws -> Any?
    ) async throws -> Any? {
        await bridgeClient.pass(turn: turn)
        try lifecycle.ensureActiveAndMarkStarted()
        guard lifecycle.isNetworkEnabled else {
            throw PyricBridgeError.unavailable("Transactions cannot be executed while the client is offline.")
        }
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
        markUsed()
        let opts = options ?? TransactionOptions()
        let turn = takeTurn()
        Task {
            do {
                let result = try await self.runTransaction(turn: turn, options: opts) { txn in
                    try await UpdateBlockThread.run {
                        var err: NSError?
                        #if canImport(ObjectiveC)
                        let res = updateBlock(txn, &err)
                        #else
                        let res = withUnsafeMutablePointer(to: &err) { ptr in
                            updateBlock(txn, ptr)
                        }
                        #endif
                        if let err {
                            throw err
                        }
                        return res
                    }
                }
                let boxedResult = TransactionCallbackResult(value: result)
                self.settings.dispatchCallback {
                    completion(boxedResult.value, nil)
                }
            } catch {
                self.settings.dispatchCallback {
                    completion(nil, error)
                }
            }
        }
    }

    // -- Network & Cache Lifecycle --

    public func enableNetwork() async throws {
        try await enableNetworkInOrder(turn: takeTurn())
    }

    public func enableNetwork(completion: (@Sendable (Error?) -> Void)? = nil) {
        runVoidInCallOrder(completion: completion) { turn in
            try await self.enableNetworkInOrder(turn: turn)
        }
    }

    public func disableNetwork() async throws {
        try await disableNetworkInOrder(turn: takeTurn())
    }

    public func disableNetwork(completion: (@Sendable (Error?) -> Void)? = nil) {
        runVoidInCallOrder(completion: completion) { turn in
            try await self.disableNetworkInOrder(turn: turn)
        }
    }

    private func disableNetworkInOrder(turn: OperationTurn) async throws {
        let client = bridgeClient
        await client.acquireTurn(turn)
        if await client.isDisposed {
            await client.finishTurn(turn)
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        do {
            try lifecycle.ensureActiveAndMarkStarted()
        } catch {
            await client.finishTurn(turn)
            throw error
        }
        hasUsed = true
        await client.flushSocketWrites()
        lifecycle.transitionToOffline()
        await client.finishTurn(turn)
    }

    private func enableNetworkInOrder(turn: OperationTurn) async throws {
        let client = bridgeClient
        await client.acquireTurn(turn)
        if await client.isDisposed {
            await client.finishTurn(turn)
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        do {
            try lifecycle.ensureActiveAndMarkStarted()
        } catch {
            await client.finishTurn(turn)
            throw error
        }
        hasUsed = true
        let flushBatch = lifecycle.beginOnlineFlush()
        if !flushBatch.wasOffline && flushBatch.writes.isEmpty {
            await client.finishTurn(turn)
            try await client.connect()
            return
        }

        var enqueuedTasks: [(StagedOfflineWriteEntry, Task<AnySendable, Error>)] = []
        enqueuedTasks.reserveCapacity(flushBatch.writes.count)
        for writeEntry in flushBatch.writes {
            let opTask = await client.startOrderedOp(
                method: writeEntry.method,
                params: writeEntry.params,
                actAs: writeEntry.actAs
            )
            enqueuedTasks.append((writeEntry, opTask))
        }
        await client.finishTurn(turn)

        try await client.connect()
        for (writeEntry, opTask) in enqueuedTasks {
            do {
                _ = try await opTask.value
                lifecycle.finishFlushedWrite(writeEntry, error: nil)
            } catch {
                lifecycle.finishFlushedWrite(writeEntry, error: error)
            }
        }

        if flushBatch.wasOffline {
            if lifecycle.hasActiveListeners {
                lifecycle.resumeManagedListenersAfterOnlineFlush()
            } else {
                lifecycle.notifyAlreadyInSyncOnReconnect(settings: settings)
            }
        }
    }

    public func clearPersistence() async throws {
        try lifecycle.clearPersistence()
    }

    public func clearPersistence(completion: (@Sendable (Error?) -> Void)? = nil) {
        let currentSettings = settings
        Task {
            do {
                try await self.clearPersistence()
                currentSettings.dispatchCallback { completion?(nil) }
            } catch {
                currentSettings.dispatchCallback { completion?(error) }
            }
        }
    }

    public func terminate() async throws {
        await terminateInOrder(turn: takeTurn())
    }

    public func terminate(completion: (@Sendable (Error?) -> Void)? = nil) {
        runVoidInCallOrder(completion: completion) { turn in
            await self.terminateInOrder(turn: turn)
        }
    }

    private func terminateInOrder(turn: OperationTurn) async {
        let client = bridgeClient
        if !usesSharedAppBridge {
            await client.disconnect(turn: turn)
            lifecycle.terminate()
            evictSelfFromRegistry()
            return
        }
        await client.acquireTurn(turn)
        await client.flushSocketWrites()
        lifecycle.terminate()
        evictSelfFromRegistry()
        if let observerId = bridgeObserverId {
            app.removeBridgeObserver(observerId)
            bridgeObserverId = nil
        }
        await client.finishTurn(turn)
    }

    public func waitForPendingWrites() async throws {
        try await waitForPendingWritesInOrder(turn: takeTurn())
    }

    public func waitForPendingWrites(completion: (@Sendable (Error?) -> Void)? = nil) {
        runVoidInCallOrder(completion: completion) { turn in
            try await self.waitForPendingWritesInOrder(turn: turn)
        }
    }

    private func waitForPendingWritesInOrder(turn: OperationTurn) async throws {
        let client = bridgeClient
        await client.acquireTurn(turn)
        if await client.isDisposed {
            await client.finishTurn(turn)
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        do {
            try lifecycle.ensureActiveAndMarkStarted()
        } catch {
            await client.finishTurn(turn)
            throw error
        }
        hasUsed = true
        let settlements = lifecycle.snapshotPendingWriteSettlements()
        await client.finishTurn(turn)
        for settlement in settlements {
            await settlement.wait()
        }
    }

    public func addSnapshotsInSyncListener(_ listener: @escaping @Sendable () -> Void) -> ListenerRegistration {
        hasUsed = true
        return lifecycle.addSnapshotsInSyncListener(listener, settings: settings)
    }
}
