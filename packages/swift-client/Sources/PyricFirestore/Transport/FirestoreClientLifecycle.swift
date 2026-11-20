import Foundation

internal final class FirestoreClientLifecycle: @unchecked Sendable {
    private final class SyncObserverEntry: @unchecked Sendable {
        var isRemoved = false
        let callback: @Sendable () -> Void

        init(_ callback: @escaping @Sendable () -> Void) {
            self.callback = callback
        }
    }

    private let appName: String
    private let database: String
    private let lock = NSLock()

    private var started = false
    private var terminated = false
    private var networkEnabled = true
    private var nextStageId = 1
    private var stagedEntries: [(stageId: Int, mutations: [OfflineWriteMutation])] = []
    private var queuedOfflineWrites: [StagedOfflineWriteEntry] = []
    private var pendingWriteSettlements: [UUID: PendingWriteSettlement] = [:]
    private var activeBundleLoads: [UUID: PendingWriteSettlement] = [:]
    private var managedListeners: [UUID: ManagedSnapshotListenerHooks] = [:]
    private var syncObservers: [UUID: SyncObserverEntry] = [:]
    private var pendingCallbackDeliveries = 0
    private var needsSyncAfterCallbacks = false

    init(appName: String, database: String) {
        self.appName = appName
        self.database = database
    }

    var isStarted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return started
    }

    var isTerminated: Bool {
        lock.lock()
        defer { lock.unlock() }
        return terminated
    }

    var isNetworkEnabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return networkEnabled
    }

    var hasActiveListeners: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !managedListeners.isEmpty
    }

    func markStarted() {
        lock.lock()
        started = true
        lock.unlock()
    }

    func ensureActiveAndMarkStarted() throws {
        lock.lock()
        if terminated {
            lock.unlock()
            throw PyricBridgeError(code: .failedPrecondition, message: "The client has already been terminated.")
        }
        started = true
        lock.unlock()
    }

    // MARK: - Pending Writes Tracking

    func beginOnlineWrite() -> UUID {
        let id = UUID()
        let settlement = PendingWriteSettlement()
        lock.lock()
        started = true
        pendingWriteSettlements[id] = settlement
        lock.unlock()
        return id
    }

    func finishOnlineWrite(_ id: UUID, committedMutations: [OfflineWriteMutation]?) {
        if let committedMutations, !committedMutations.isEmpty {
            applyCommittedMutations(committedMutations)
            notifyCacheOnlyListeners(for: Set(committedMutations.map(\.path)))
        }
        lock.lock()
        let settlement = pendingWriteSettlements.removeValue(forKey: id)
        lock.unlock()
        settlement?.markSettled()
    }

    private func notifyCacheOnlyListeners(for touchedPaths: Set<String>) {
        guard !touchedPaths.isEmpty else { return }
        let listenersToNotify: [ManagedSnapshotListenerHooks]
        lock.lock()
        listenersToNotify = managedListeners.values.filter { hooks in
            hooks.cacheOnly && touchedPaths.contains {
                FirestoreOfflineProjection.targetMatchesPath(hooks.target, path: $0)
            }
        }
        lock.unlock()
        for hooks in listenersToNotify {
            hooks.deliverOfflineProjection()
        }
    }

    func stageOfflineWrite(
        method: String,
        params: [String: AnySendable],
        actAs: AuthLens,
        mutations: [OfflineWriteMutation],
        continuation: CheckedContinuation<Void, Error>
    ) {
        let writeId = UUID()
        let settlement = PendingWriteSettlement()
        let touchedPaths = Set(mutations.map(\.path))
        let listenersToNotify: [ManagedSnapshotListenerHooks]

        lock.lock()
        started = true
        let stageId = nextStageId
        nextStageId += 1
        stagedEntries.append((stageId: stageId, mutations: mutations))
        pendingWriteSettlements[writeId] = settlement
        queuedOfflineWrites.append(
            StagedOfflineWriteEntry(
                stageId: stageId,
                writeId: writeId,
                method: method,
                params: params,
                actAs: actAs,
                mutations: mutations,
                continuation: continuation
            )
        )
        listenersToNotify = managedListeners.values.filter { hooks in
            touchedPaths.contains { FirestoreOfflineProjection.targetMatchesPath(hooks.target, path: $0) }
        }
        lock.unlock()

        for hooks in listenersToNotify {
            hooks.deliverOfflineProjection()
        }
    }

    func snapshotPendingWriteSettlements() -> [PendingWriteSettlement] {
        lock.lock()
        defer { lock.unlock() }
        started = true
        return Array(pendingWriteSettlements.values)
    }

    // MARK: - Network Toggle & Flush

    func transitionToOffline() {
        let listeners: [ManagedSnapshotListenerHooks]
        lock.lock()
        started = true
        guard networkEnabled else {
            lock.unlock()
            return
        }
        networkEnabled = false
        listeners = Array(managedListeners.values)
        lock.unlock()

        for hooks in listeners where !hooks.cacheOnly {
            let shouldDeliverGap = !hooks.hasDeliveredAny()
                || (hooks.includeMetadataChanges && hooks.hasDeliveredOnline())
            hooks.suspendFromHost()
            if shouldDeliverGap {
                hooks.deliverOfflineProjection()
            }
        }
    }

    func beginOnlineFlush() -> (wasOffline: Bool, writes: [StagedOfflineWriteEntry]) {
        lock.lock()
        defer { lock.unlock() }
        started = true
        let wasOffline = !networkEnabled
        networkEnabled = true
        let writes = queuedOfflineWrites
        queuedOfflineWrites.removeAll()
        return (wasOffline: wasOffline, writes: writes)
    }

    func finishFlushedWrite(_ entry: StagedOfflineWriteEntry, error: Error?) {
        if error == nil {
            applyCommittedMutations(entry.mutations)
        }
        let listenersToRefreshOnRollback: [ManagedSnapshotListenerHooks]
        lock.lock()
        stagedEntries.removeAll { $0.stageId == entry.stageId }
        let settlement = pendingWriteSettlements.removeValue(forKey: entry.writeId)
        if error != nil && !networkEnabled {
            let touched = Set(entry.mutations.map(\.path))
            listenersToRefreshOnRollback = managedListeners.values.filter { hooks in
                touched.contains { FirestoreOfflineProjection.targetMatchesPath(hooks.target, path: $0) }
            }
        } else {
            listenersToRefreshOnRollback = []
        }
        lock.unlock()

        if let error {
            entry.continuation.resume(throwing: error)
        } else {
            entry.continuation.resume(returning: ())
        }
        settlement?.markSettled()

        for hooks in listenersToRefreshOnRollback {
            hooks.deliverOfflineProjection()
        }
    }

    func resumeManagedListenersAfterOnlineFlush() {
        let listeners: [ManagedSnapshotListenerHooks]
        lock.lock()
        guard networkEnabled && !terminated else {
            lock.unlock()
            return
        }
        listeners = Array(managedListeners.values)
        lock.unlock()

        for hooks in listeners {
            hooks.resumeOnHost()
        }
    }

    // MARK: - Cache Reads & Updates

    func readCachedDocumentWire(path: String) throws -> AnySendable {
        let baseDocs = FirestorePersistenceStore.shared.docsSnapshot(appName: appName, database: database)
        let batches: [[OfflineWriteMutation]]
        lock.lock()
        batches = stagedEntries.map(\.mutations)
        lock.unlock()

        let projected = FirestoreOfflineProjection.projectDocument(
            path: path,
            baseRecord: baseDocs[path],
            stagedBatches: batches
        )
        guard projected.known else {
            throw PyricBridgeError.unavailable("Failed to get document from cache.")
        }
        return projected.wirePayload
    }

    func projectOfflineDocumentWire(path: String) -> AnySendable {
        let baseDocs = FirestorePersistenceStore.shared.docsSnapshot(appName: appName, database: database)
        let batches: [[OfflineWriteMutation]]
        lock.lock()
        batches = stagedEntries.map(\.mutations)
        lock.unlock()
        return FirestoreOfflineProjection.projectDocument(
            path: path,
            baseRecord: baseDocs[path],
            stagedBatches: batches
        ).wirePayload
    }

    func projectOfflineQueryWire(target: TargetDescriptor) -> AnySendable {
        let baseDocs = FirestorePersistenceStore.shared.docsSnapshot(appName: appName, database: database)
        let batches: [[OfflineWriteMutation]]
        lock.lock()
        batches = stagedEntries.map(\.mutations)
        lock.unlock()
        return FirestoreOfflineProjection.projectQuery(
            target: target,
            baseDocs: baseDocs,
            stagedBatches: batches
        )
    }

    func recordOnlineDocWire(path: String, wire: AnySendable) {
        let exists = wire["exists"]?.boolValue ?? true
        if !exists && wire["exists"] != nil {
            FirestorePersistenceStore.shared.recordDoc(
                appName: appName,
                database: database,
                path: path,
                exists: false,
                encodedFields: nil
            )
            return
        }
        let encodedFields = extractWireFields(from: wire["data"] ?? wire)
        FirestorePersistenceStore.shared.recordDoc(
            appName: appName,
            database: database,
            path: path,
            exists: true,
            encodedFields: encodedFields
        )
    }

    func recordOnlineQueryWire(_ wire: AnySendable) {
        FirestorePersistenceStore.shared.markQueryWarmed(appName: appName, database: database)
        guard let docs = wire["docs"]?.arrayValue else { return }
        for item in docs {
            guard let docPath = item["path"]?.stringValue else { continue }
            recordOnlineDocWire(path: docPath, wire: item)
        }
    }

    func recordBundledEntry(_ entry: BundledDocumentEntry) {
        FirestorePersistenceStore.shared.recordDoc(
            appName: appName,
            database: database,
            path: entry.docPath,
            exists: entry.exists,
            encodedFields: entry.encodedFields
        )
        notifyCacheOnlyListeners(for: [entry.docPath])
    }

    func recordBundledNamedQuery(_ spec: BundledNamedQuerySpec) {
        FirestorePersistenceStore.shared.recordNamedQuery(appName: appName, database: database, spec: spec)
    }

    func bundledNamedQuery(named name: String) -> BundledNamedQuerySpec? {
        FirestorePersistenceStore.shared.namedQuery(appName: appName, database: database, name: name)
    }

    func beginBundleLoad() -> UUID {
        let id = UUID()
        let settlement = PendingWriteSettlement()
        lock.lock()
        started = true
        activeBundleLoads[id] = settlement
        lock.unlock()
        return id
    }

    func finishBundleLoad(_ id: UUID) {
        lock.lock()
        let settlement = activeBundleLoads.removeValue(forKey: id)
        lock.unlock()
        settlement?.markSettled()
    }

    func snapshotActiveBundleLoads() -> [PendingWriteSettlement] {
        lock.lock()
        defer { lock.unlock() }
        return Array(activeBundleLoads.values)
    }

    private func applyCommittedMutations(_ mutations: [OfflineWriteMutation]) {
        let currentBase = FirestorePersistenceStore.shared.docsSnapshot(appName: appName, database: database)
        for mutation in mutations {
            switch mutation {
            case .delete(let path):
                FirestorePersistenceStore.shared.removeDoc(appName: appName, database: database, path: path)
            case .set(let path, _, _, _), .update(let path, _), .updateSegments(let path, _):
                let projected = FirestoreOfflineProjection.projectDocument(
                    path: path,
                    baseRecord: currentBase[path],
                    stagedBatches: [[mutation]]
                )
                if projected.exists {
                    FirestorePersistenceStore.shared.recordDoc(
                        appName: appName,
                        database: database,
                        path: path,
                        exists: true,
                        encodedFields: projected.encodedFields
                    )
                }
            }
        }
    }

    private func extractWireFields(from rawData: AnySendable) -> [String: AnySendable] {
        if let jsonStr = rawData["json"]?.stringValue,
           let data = jsonStr.data(using: .utf8),
           let decoded = try? JSONDecoder().decode(AnySendable.self, from: data),
           let dict = decoded.dictionaryValue {
            if dict["type"]?.stringValue == "pyric/map/1.0", let inner = dict["fields"]?.dictionaryValue {
                return inner
            }
            return dict
        }
        return rawData.dictionaryValue ?? [:]
    }

    // MARK: - Persistence Clearing & Termination

    func clearPersistence() throws {
        lock.lock()
        let running = started && !terminated
        let activeCount = managedListeners.count
        if running || activeCount > 0 {
            lock.unlock()
            throw PyricBridgeError(
                code: .failedPrecondition,
                message: "Persistence cannot be cleared while the Firestore instance is running."
            )
        }
        stagedEntries.removeAll()
        lock.unlock()
        FirestorePersistenceStore.shared.clear(appName: appName, database: database)
    }

    func terminate() {
        let listeners: [ManagedSnapshotListenerHooks]
        let abortedWrites: [StagedOfflineWriteEntry]
        let settlements: [PendingWriteSettlement]

        lock.lock()
        guard !terminated else {
            lock.unlock()
            return
        }
        terminated = true
        listeners = Array(managedListeners.values)
        managedListeners.removeAll()
        for entry in syncObservers.values {
            entry.isRemoved = true
        }
        syncObservers.removeAll()
        abortedWrites = queuedOfflineWrites
        queuedOfflineWrites.removeAll()
        stagedEntries.removeAll()
        settlements = Array(pendingWriteSettlements.values) + Array(activeBundleLoads.values)
        pendingWriteSettlements.removeAll()
        activeBundleLoads.removeAll()
        lock.unlock()

        for hooks in listeners {
            hooks.cancelFromTerminate()
        }
        let err = PyricBridgeError(code: .aborted, message: "The client has already been terminated.")
        for write in abortedWrites {
            write.continuation.resume(throwing: err)
        }
        for settlement in settlements {
            settlement.markSettled()
        }
    }

    // MARK: - Listener Registration & SnapshotsInSync

    func registerManagedListener(_ hooks: ManagedSnapshotListenerHooks) -> UUID {
        let id = UUID()
        lock.lock()
        started = true
        if !terminated {
            managedListeners[id] = hooks
        }
        lock.unlock()
        return id
    }

    func unregisterManagedListener(_ id: UUID) {
        lock.lock()
        managedListeners.removeValue(forKey: id)
        lock.unlock()
    }

    func addSnapshotsInSyncListener(
        _ listener: @escaping @Sendable () -> Void,
        settings: FirestoreSettings
    ) -> ListenerRegistration {
        let id = UUID()
        let entry = SyncObserverEntry(listener)
        let shouldFireInitialNow: Bool
        lock.lock()
        started = true
        if terminated {
            lock.unlock()
            return SimpleListenerRegistration {}
        }
        syncObservers[id] = entry
        shouldFireInitialNow = (pendingCallbackDeliveries == 0)
        if !shouldFireInitialNow {
            needsSyncAfterCallbacks = true
        }
        lock.unlock()

        if shouldFireInitialNow {
            settings.dispatchCallback {
                guard !entry.isRemoved else { return }
                entry.callback()
            }
        }

        return SimpleListenerRegistration { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let removed = self.syncObservers.removeValue(forKey: id)
            removed?.isRemoved = true
            self.lock.unlock()
        }
    }

    func dispatchSnapshotCallback(
        settings: FirestoreSettings,
        isCancelled: @escaping @Sendable () -> Bool,
        callback: @escaping @Sendable () -> Void
    ) {
        lock.lock()
        pendingCallbackDeliveries += 1
        lock.unlock()

        settings.dispatchCallback { [weak self] in
            let cancelled = isCancelled()
            if !cancelled {
                callback()
            }
            guard let self else { return }
            self.lock.lock()
            self.pendingCallbackDeliveries = max(0, self.pendingCallbackDeliveries - 1)
            if !cancelled {
                self.needsSyncAfterCallbacks = true
            }
            let shouldFireSync = (self.pendingCallbackDeliveries == 0 && self.needsSyncAfterCallbacks)
            let observers: [SyncObserverEntry]
            if shouldFireSync {
                self.needsSyncAfterCallbacks = false
                observers = Array(self.syncObservers.values)
            } else {
                observers = []
            }
            self.lock.unlock()

            for observer in observers where !observer.isRemoved {
                observer.callback()
            }
        }
    }

    func notifyAlreadyInSyncOnReconnect(settings: FirestoreSettings) {
        let observers: [SyncObserverEntry]
        lock.lock()
        guard pendingCallbackDeliveries == 0 else {
            needsSyncAfterCallbacks = true
            lock.unlock()
            return
        }
        observers = Array(syncObservers.values)
        lock.unlock()

        guard !observers.isEmpty else { return }
        settings.dispatchCallback {
            for observer in observers where !observer.isRemoved {
                observer.callback()
            }
        }
    }
}
