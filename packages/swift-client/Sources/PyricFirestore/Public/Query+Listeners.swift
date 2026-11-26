import Foundation

extension Query {

    public func addSnapshotListener(
        _ listener: @escaping @Sendable (QuerySnapshot?, Error?) -> Void
    ) -> ListenerRegistration {
        addSnapshotListener(options: SnapshotListenOptions(includeMetadataChanges: false), listener: listener)
    }

    public func addSnapshotListener(
        includeMetadataChanges: Bool,
        listener: @escaping @Sendable (QuerySnapshot?, Error?) -> Void
    ) -> ListenerRegistration {
        addSnapshotListener(
            options: SnapshotListenOptions(includeMetadataChanges: includeMetadataChanges),
            listener: listener
        )
    }

    public func addSnapshotListener(
        options: SnapshotListenOptions,
        listener: @escaping @Sendable (QuerySnapshot?, Error?) -> Void
    ) -> ListenerRegistration {
        firestore.markUsed()
        let includeMetadataChanges = options.includeMetadataChanges
        let listenSource = (options.source == .cache) ? "cache" : nil
        let db = self.firestore
        let box = QueryCallbackBox(listener)
        let stateBox = QuerySnapshotStateBox()

        let target: TargetDescriptor
        do {
            target = try QueryCompiler.compile(query: self)
        } catch {
            db.settings.dispatchCallback {
                stateBox.runIfActive {
                    box.callback(nil, error)
                }
            }
            return SimpleListenerRegistration {
                stateBox.markCancelled()
            }
        }

        let coordinator = SnapshotSubscriptionCoordinator(
            firestore: db,
            target: target,
            includeMetadataChanges: includeMetadataChanges,
            listenSource: listenSource,
            onEvent: { event in
                db.lifecycle.recordOnlineQueryWire(event)
                let (prevDocs, hadDeliveredFromCache) = stateBox.snapshotPrevious()
                let snapshot = QuerySnapshot.fromWire(
                    firestore: db,
                    query: self,
                    wire: event,
                    previousDocs: prevDocs,
                    excludesMetadataChanges: !includeMetadataChanges
                )
                stateBox.record(docs: snapshot.documents, wire: event, fromCache: snapshot.metadata.isFromCache)
                if !includeMetadataChanges
                    && hadDeliveredFromCache
                    && !snapshot.metadata.hasPendingWrites
                    && snapshot.documentChanges.isEmpty
                    && snapshot.documents.count == (prevDocs?.count ?? -1) {
                    db.lifecycle.notifyAlreadyInSyncOnReconnect(settings: db.settings)
                    return
                }
                db.lifecycle.dispatchSnapshotCallback(
                    settings: db.settings,
                    isCancelled: { stateBox.isCancelled }
                ) {
                    stateBox.runIfActive {
                        box.callback(snapshot, nil)
                    }
                }
            },
            onOffline: {
                let wire = db.lifecycle.projectOfflineQueryWire(target: target)
                let (prevDocs, _) = stateBox.snapshotPrevious()
                let snapshot = QuerySnapshot.fromWire(
                    firestore: db,
                    query: self,
                    wire: wire,
                    previousDocs: prevDocs,
                    isFromCache: true,
                    excludesMetadataChanges: !includeMetadataChanges
                )
                stateBox.record(docs: snapshot.documents, wire: wire, fromCache: true)
                db.lifecycle.dispatchSnapshotCallback(
                    settings: db.settings,
                    isCancelled: { stateBox.isCancelled }
                ) {
                    stateBox.runIfActive {
                        box.callback(snapshot, nil)
                    }
                }
            },
            onGap: {
                let (prevDocs, _) = stateBox.snapshotPrevious()
                guard let lastWire = stateBox.lastWire else { return }
                let snapshot = QuerySnapshot.fromWire(
                    firestore: db,
                    query: self,
                    wire: lastWire,
                    previousDocs: prevDocs ?? [],
                    isFromCache: true,
                    excludesMetadataChanges: !includeMetadataChanges
                )
                stateBox.record(docs: snapshot.documents, wire: lastWire, fromCache: true)
                db.lifecycle.dispatchSnapshotCallback(
                    settings: db.settings,
                    isCancelled: { stateBox.isCancelled }
                ) {
                    stateBox.runIfActive {
                        box.callback(snapshot, nil)
                    }
                }
            },
            onError: { error in
                db.settings.dispatchCallback {
                    stateBox.runIfActive {
                        box.callback(nil, error)
                    }
                }
            }
        )

        return SimpleListenerRegistration {
            stateBox.markCancelled()
            coordinator.cancel()
        }
    }

    public var snapshots: AsyncThrowingStream<QuerySnapshot, Error> {
        snapshots(includeMetadataChanges: false)
    }

    public func snapshots(includeMetadataChanges: Bool) -> AsyncThrowingStream<QuerySnapshot, Error> {
        AsyncThrowingStream { continuation in
            let reg = self.addSnapshotListener(includeMetadataChanges: includeMetadataChanges) { snap, err in
                if let err {
                    continuation.finish(throwing: err)
                } else if let snap {
                    continuation.yield(snap)
                }
            }
            continuation.onTermination = { @Sendable _ in
                reg.remove()
            }
        }
    }

    // -- Aggregations --

    public var count: AggregateQuery {
        AggregateQuery(query: self, aggregateFields: [AggregateField.count()])
    }

    public func aggregate(_ aggregateFields: [AggregateField]) -> AggregateQuery {
        AggregateQuery(query: self, aggregateFields: aggregateFields)
    }

    public func aggregate(_ field1: AggregateField, _ fields: AggregateField...) -> AggregateQuery {
        var all = [field1]
        all.append(contentsOf: fields)
        return aggregate(all)
    }
}

private final class QueryCallbackBox<T: Sendable>: @unchecked Sendable {
    let callback: @Sendable (T?, Error?) -> Void
    init(_ callback: @escaping @Sendable (T?, Error?) -> Void) {
        self.callback = callback
    }
}

private final class QuerySnapshotStateBox: @unchecked Sendable {
    private let callbackLock = NSRecursiveLock()
    private let lock = NSLock()
    private var cancelled = false
    private var previousDocs: [QueryDocumentSnapshot]?
    private var _lastWire: AnySendable?
    private var lastFromCache = false

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    var lastWire: AnySendable? {
        lock.lock()
        defer { lock.unlock() }
        return _lastWire
    }

    func markCancelled() {
        callbackLock.lock()
        defer { callbackLock.unlock() }
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    func runIfActive(_ block: () -> Void) {
        callbackLock.lock()
        defer { callbackLock.unlock() }
        guard !isCancelled else { return }
        block()
    }

    func snapshotPrevious() -> ([QueryDocumentSnapshot]?, Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (previousDocs, lastFromCache)
    }

    func record(docs: [QueryDocumentSnapshot], wire: AnySendable, fromCache: Bool) {
        lock.lock()
        previousDocs = docs
        _lastWire = wire
        lastFromCache = fromCache
        lock.unlock()
    }
}
