import Foundation
import PyricFirestore

/// Represents a query over data at a Realtime Database location.
public class DatabaseQuery: NSObject, @unchecked Sendable {
    public let database: Database
    public let path: String

    internal let orderBySpec: [String: AnySendable]?
    internal let boundsSpec: [[String: AnySendable]]
    internal let limitSpec: [String: AnySendable]?

    private let observerLock = NSLock()
    private var observerTasks: [UInt: Task<Void, Never>] = [:]
    nonisolated(unsafe) private static var nextObserverHandle: UInt = 1

    public init(
        database: Database,
        path: String,
        orderBySpec: [String: AnySendable]? = nil,
        boundsSpec: [[String: AnySendable]] = [],
        limitSpec: [String: AnySendable]? = nil
    ) {
        self.database = database
        self.path = path
        self.orderBySpec = orderBySpec
        self.boundsSpec = boundsSpec
        self.limitSpec = limitSpec
        super.init()
    }

    /// Returns a DatabaseReference to the query's path.
    public var ref: DatabaseReference {
        return DatabaseReference(database: database, path: path)
    }

    internal func toQuerySpecAnySendable() -> AnySendable? {
        if orderBySpec == nil && boundsSpec.isEmpty && limitSpec == nil {
            return nil
        }
        var spec: [String: AnySendable] = [:]
        if let orderBySpec {
            spec["orderBy"] = .dictionary(orderBySpec)
        } else {
            spec["orderBy"] = .null
        }
        spec["bounds"] = .array(boundsSpec.map { .dictionary($0) })
        if let limitSpec {
            spec["limit"] = .dictionary(limitSpec)
        } else {
            spec["limit"] = .null
        }
        return .dictionary(spec)
    }

    // ── Query Ordering ────────────────────────────────────────────────────────

    public func queryOrdered(byChild key: String) -> DatabaseQuery {
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: ["kind": .string("child"), "path": .string(key)],
            boundsSpec: boundsSpec,
            limitSpec: limitSpec
        )
    }

    public func queryOrderedByKey() -> DatabaseQuery {
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: ["kind": .string("key")],
            boundsSpec: boundsSpec,
            limitSpec: limitSpec
        )
    }

    public func queryOrderedByValue() -> DatabaseQuery {
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: ["kind": .string("value")],
            boundsSpec: boundsSpec,
            limitSpec: limitSpec
        )
    }

    public func queryOrderedByPriority() -> DatabaseQuery {
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: ["kind": .string("priority")],
            boundsSpec: boundsSpec,
            limitSpec: limitSpec
        )
    }

    // ── Query Filtering / Range Bounds ────────────────────────────────────────

    public func queryStarting(atValue value: Any?, childKey: String? = nil) -> DatabaseQuery {
        var bound: [String: AnySendable] = [
            "kind": .string("startAt"),
            "value": RtdbValueCodec.toAnySendable(value)
        ]
        if let childKey { bound["key"] = .string(childKey) }
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: orderBySpec,
            boundsSpec: boundsSpec + [bound],
            limitSpec: limitSpec
        )
    }

    public func queryStarting(afterValue value: Any?, childKey: String? = nil) -> DatabaseQuery {
        var bound: [String: AnySendable] = [
            "kind": .string("startAfter"),
            "value": RtdbValueCodec.toAnySendable(value)
        ]
        if let childKey { bound["key"] = .string(childKey) }
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: orderBySpec,
            boundsSpec: boundsSpec + [bound],
            limitSpec: limitSpec
        )
    }

    public func queryEnding(atValue value: Any?, childKey: String? = nil) -> DatabaseQuery {
        var bound: [String: AnySendable] = [
            "kind": .string("endAt"),
            "value": RtdbValueCodec.toAnySendable(value)
        ]
        if let childKey { bound["key"] = .string(childKey) }
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: orderBySpec,
            boundsSpec: boundsSpec + [bound],
            limitSpec: limitSpec
        )
    }

    public func queryEnding(beforeValue value: Any?, childKey: String? = nil) -> DatabaseQuery {
        var bound: [String: AnySendable] = [
            "kind": .string("endBefore"),
            "value": RtdbValueCodec.toAnySendable(value)
        ]
        if let childKey { bound["key"] = .string(childKey) }
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: orderBySpec,
            boundsSpec: boundsSpec + [bound],
            limitSpec: limitSpec
        )
    }

    public func queryEqual(toValue value: Any?, childKey: String? = nil) -> DatabaseQuery {
        var bound: [String: AnySendable] = [
            "kind": .string("equalTo"),
            "value": RtdbValueCodec.toAnySendable(value)
        ]
        if let childKey { bound["key"] = .string(childKey) }
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: orderBySpec,
            boundsSpec: boundsSpec + [bound],
            limitSpec: limitSpec
        )
    }

    // ── Query Limits ──────────────────────────────────────────────────────────

    public func queryLimited(toFirst limit: UInt) -> DatabaseQuery {
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: orderBySpec,
            boundsSpec: boundsSpec,
            limitSpec: ["kind": .string("limitToFirst"), "n": .int(Int64(limit))]
        )
    }

    public func queryLimited(toLast limit: UInt) -> DatabaseQuery {
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: orderBySpec,
            boundsSpec: boundsSpec,
            limitSpec: ["kind": .string("limitToLast"), "n": .int(Int64(limit))]
        )
    }

    // ── One-Shot Reads ────────────────────────────────────────────────────────

    public func getData() async throws -> DataSnapshot {
        var params: [String: AnySendable] = [
            "path": .string(path)
        ]
        if let qSpec = toQuerySpecAnySendable() {
            params["query"] = qSpec
        }
        let wire = try await database.bridgeClient.op(
            method: "rtdb.get",
            params: params,
            actAs: database.currentAuthLens()
        )
        return DataSnapshot(wire: wire, ref: ref)
    }

    public func observeSingleEvent(of eventType: DataEventType) async throws -> DataSnapshot {
        return try await getData()
    }

    // ── Real-Time Listeners & AsyncStreams ────────────────────────────────────

    public var valueStream: AsyncThrowingStream<DataSnapshot, Error> {
        AsyncThrowingStream { continuation in
            let handle = self.observe(.value, with: { snap in
                continuation.yield(snap)
            }, withCancel: { err in
                continuation.finish(throwing: err)
            })
            continuation.onTermination = { _ in
                self.removeObserver(withHandle: handle)
            }
        }
    }

    public var childEvents: AsyncThrowingStream<DatabaseChildEvent, Error> {
        AsyncThrowingStream { continuation in
            let handle = self.observeAllChildEvents(with: { event in
                continuation.yield(event)
            }, withCancel: { err in
                continuation.finish(throwing: err)
            })
            continuation.onTermination = { _ in
                self.removeObserver(withHandle: handle)
            }
        }
    }

    @discardableResult
    public func observe(
        _ eventType: DataEventType,
        with block: @escaping @Sendable (DataSnapshot) -> Void,
        withCancel cancelBlock: (@Sendable (Error) -> Void)? = nil
    ) -> UInt {
        return observe(eventType, andPreviousSiblingKeyWith: { snap, _ in
            block(snap)
        }, withCancel: cancelBlock)
    }

    @discardableResult
    public func observe(
        _ eventType: DataEventType,
        andPreviousSiblingKeyWith block: @escaping @Sendable (DataSnapshot, String?) -> Void,
        withCancel cancelBlock: (@Sendable (Error) -> Void)? = nil
    ) -> UInt {
        observerLock.lock()
        let handle = DatabaseQuery.nextObserverHandle
        DatabaseQuery.nextObserverHandle += 1
        observerLock.unlock()

        let task = startObserverTask(
            eventTypes: [eventType],
            onEvent: { event in
                block(event.snapshot, event.previousSiblingKey)
            },
            onCancel: cancelBlock
        )

        observerLock.lock()
        observerTasks[handle] = task
        observerLock.unlock()
        return handle
    }

    private func observeAllChildEvents(
        with block: @escaping @Sendable (DatabaseChildEvent) -> Void,
        withCancel cancelBlock: (@Sendable (Error) -> Void)? = nil
    ) -> UInt {
        observerLock.lock()
        let handle = DatabaseQuery.nextObserverHandle
        DatabaseQuery.nextObserverHandle += 1
        observerLock.unlock()

        let task = startObserverTask(
            eventTypes: [.childAdded, .childChanged, .childRemoved],
            onEvent: block,
            onCancel: cancelBlock
        )

        observerLock.lock()
        observerTasks[handle] = task
        observerLock.unlock()
        return handle
    }

    public func removeObserver(withHandle handle: UInt) {
        observerLock.lock()
        let task = observerTasks.removeValue(forKey: handle)
        observerLock.unlock()
        task?.cancel()
    }

    public func removeAllObservers() {
        observerLock.lock()
        let tasks = Array(observerTasks.values)
        observerTasks.removeAll()
        observerLock.unlock()
        for task in tasks {
            task.cancel()
        }
    }

    private func startObserverTask(
        eventTypes: Set<DataEventType>,
        onEvent: @escaping @Sendable (DatabaseChildEvent) -> Void,
        onCancel: (@Sendable (Error) -> Void)?
    ) -> Task<Void, Never> {
        var targetDict: [String: AnySendable] = [
            "service": .string("rtdb"),
            "path": .string(path)
        ]
        if let qSpec = toQuerySpecAnySendable() {
            targetDict["query"] = qSpec
        }
        let targetSendable = AnySendable.dictionary(targetDict)
        let db = self.database
        let queryRef = self.ref

        return Task {
            var previousChildren: [DataSnapshot] = []
            var isFirstSnapshot = true

            // Listen to authLensStream so identity changes re-evaluate subscriptions automatically.
            for await currentLens in db.authLensStream {
                if Task.isCancelled { break }

                let subStream = db.bridgeClient.subscribe(
                    target: targetSendable,
                    actAs: currentLens.toAnySendable()
                )

                final class LensChangeFlag: @unchecked Sendable {
                    private let lock = NSLock()
                    private var _value = false
                    var value: Bool {
                        get { lock.lock(); defer { lock.unlock() }; return _value }
                        set { lock.lock(); defer { lock.unlock() }; _value = newValue }
                    }
                }
                let lensChanged = LensChangeFlag()
                let lensMonitorTask = Task {
                    for await newLens in db.authLensStream {
                        if newLens != currentLens {
                            lensChanged.value = true
                            break
                        }
                    }
                }

                do {
                    for try await wireSnap in subStream {
                        if Task.isCancelled || lensChanged.value { break }
                        if let errDict = wireSnap["__error"] {
                            let msg = errDict["message"]?.stringValue ?? "Permission denied"
                            onCancel?(PyricBridgeError.permissionDenied(msg))
                            lensMonitorTask.cancel()
                            return
                        }

                        let snap = DataSnapshot(wire: wireSnap, ref: queryRef)

                        if eventTypes.contains(.value) {
                            onEvent(DatabaseChildEvent(type: .value, snapshot: snap, previousSiblingKey: nil))
                        }

                        let newChildren = snap.childrenSnapshots
                        if isFirstSnapshot {
                            isFirstSnapshot = false
                            if eventTypes.contains(.childAdded) {
                                var prevKey: String? = nil
                                for child in newChildren {
                                    onEvent(DatabaseChildEvent(type: .childAdded, snapshot: child, previousSiblingKey: prevKey))
                                    prevKey = child.key
                                }
                            }
                        } else {
                            let oldByKey = Dictionary(uniqueKeysWithValues: previousChildren.compactMap { c in c.key.map { ($0, c) } })
                            let newByKey = Dictionary(uniqueKeysWithValues: newChildren.compactMap { c in c.key.map { ($0, c) } })

                            if eventTypes.contains(.childRemoved) {
                                for oldChild in previousChildren {
                                    if let key = oldChild.key, newByKey[key] == nil {
                                        onEvent(DatabaseChildEvent(type: .childRemoved, snapshot: oldChild, previousSiblingKey: nil))
                                    }
                                }
                            }

                            var prevKey: String? = nil
                            for newChild in newChildren {
                                guard let key = newChild.key else { continue }
                                if let oldChild = oldByKey[key] {
                                    if eventTypes.contains(.childChanged) {
                                        let oldVal = RtdbValueCodec.toAnySendable(oldChild.value)
                                        let newVal = RtdbValueCodec.toAnySendable(newChild.value)
                                        if oldVal != newVal {
                                            onEvent(DatabaseChildEvent(type: .childChanged, snapshot: newChild, previousSiblingKey: prevKey))
                                        }
                                    }
                                } else {
                                    if eventTypes.contains(.childAdded) {
                                        onEvent(DatabaseChildEvent(type: .childAdded, snapshot: newChild, previousSiblingKey: prevKey))
                                    }
                                }
                                prevKey = key
                            }
                        }
                        previousChildren = newChildren
                    }
                } catch {
                    if !Task.isCancelled && !lensChanged.value {
                        onCancel?(error)
                        lensMonitorTask.cancel()
                        return
                    }
                }
                lensMonitorTask.cancel()
            }
        }
    }
}
