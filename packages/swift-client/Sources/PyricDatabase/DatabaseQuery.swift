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
    private var localObserverHandles: Set<UInt> = []

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

    internal func toSubscriptionTargetAnySendable() -> AnySendable {
        var targetDict: [String: AnySendable] = [
            "service": .string("rtdb"),
            "path": .string(path),
        ]
        if let instance = database.wireInstance {
            targetDict["instance"] = .string(instance)
        }
        if let qSpec = toQuerySpecAnySendable() {
            targetDict["query"] = qSpec
        }
        return .dictionary(targetDict)
    }

    // -- Query Ordering --

    public func queryOrdered(byChild key: String) -> DatabaseQuery {
        return requireValidQuery { try validatedQueryOrdered(byChild: key) }
    }

    package func validatedQueryOrdered(byChild key: String) throws -> DatabaseQuery {
        let cleanPath = try DatabaseQueryValidator.validateOrderByChild(
            key,
            existingOrderBy: orderBySpec
        )
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: ["kind": .string("child"), "path": .string(cleanPath)],
            boundsSpec: boundsSpec,
            limitSpec: limitSpec
        )
    }

    public func queryOrderedByKey() -> DatabaseQuery {
        return requireValidQuery { try validatedQueryOrderedByKey() }
    }

    package func validatedQueryOrderedByKey() throws -> DatabaseQuery {
        try DatabaseQueryValidator.validateOrderByKey(
            existingOrderBy: orderBySpec,
            existingBounds: boundsSpec
        )
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: ["kind": .string("key")],
            boundsSpec: boundsSpec,
            limitSpec: limitSpec
        )
    }

    public func queryOrderedByValue() -> DatabaseQuery {
        return requireValidQuery { try validatedQueryOrderedByValue() }
    }

    package func validatedQueryOrderedByValue() throws -> DatabaseQuery {
        try DatabaseQueryValidator.validateOrderByOther(existingOrderBy: orderBySpec)
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: ["kind": .string("value")],
            boundsSpec: boundsSpec,
            limitSpec: limitSpec
        )
    }

    public func queryOrderedByPriority() -> DatabaseQuery {
        return requireValidQuery { try validatedQueryOrderedByPriority() }
    }

    package func validatedQueryOrderedByPriority() throws -> DatabaseQuery {
        try DatabaseQueryValidator.validateOrderByOther(existingOrderBy: orderBySpec)
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: ["kind": .string("priority")],
            boundsSpec: boundsSpec,
            limitSpec: limitSpec
        )
    }

    // -- Query Filtering / Range Bounds --

    public func queryStarting(atValue value: Any?, childKey: String? = nil) -> DatabaseQuery {
        return requireValidQuery { try validatedQueryStarting(atValue: value, childKey: childKey) }
    }

    package func validatedQueryStarting(atValue value: Any?, childKey: String? = nil) throws -> DatabaseQuery {
        return try appendingValidatedBound(kind: "startAt", value: value, childKey: childKey)
    }

    public func queryStarting(afterValue value: Any?, childKey: String? = nil) -> DatabaseQuery {
        return requireValidQuery { try validatedQueryStarting(afterValue: value, childKey: childKey) }
    }

    package func validatedQueryStarting(afterValue value: Any?, childKey: String? = nil) throws -> DatabaseQuery {
        return try appendingValidatedBound(kind: "startAfter", value: value, childKey: childKey)
    }

    public func queryEnding(atValue value: Any?, childKey: String? = nil) -> DatabaseQuery {
        return requireValidQuery { try validatedQueryEnding(atValue: value, childKey: childKey) }
    }

    package func validatedQueryEnding(atValue value: Any?, childKey: String? = nil) throws -> DatabaseQuery {
        return try appendingValidatedBound(kind: "endAt", value: value, childKey: childKey)
    }

    public func queryEnding(beforeValue value: Any?, childKey: String? = nil) -> DatabaseQuery {
        return requireValidQuery { try validatedQueryEnding(beforeValue: value, childKey: childKey) }
    }

    package func validatedQueryEnding(beforeValue value: Any?, childKey: String? = nil) throws -> DatabaseQuery {
        return try appendingValidatedBound(kind: "endBefore", value: value, childKey: childKey)
    }

    public func queryEqual(toValue value: Any?, childKey: String? = nil) -> DatabaseQuery {
        return requireValidQuery { try validatedQueryEqual(toValue: value, childKey: childKey) }
    }

    package func validatedQueryEqual(toValue value: Any?, childKey: String? = nil) throws -> DatabaseQuery {
        return try appendingValidatedBound(kind: "equalTo", value: value, childKey: childKey)
    }

    // -- Query Limits --

    public func queryLimited(toFirst limit: UInt) -> DatabaseQuery {
        return requireValidQuery { try validatedQueryLimited(toFirst: limit) }
    }

    package func validatedQueryLimited(toFirst limit: UInt) throws -> DatabaseQuery {
        let validated = try DatabaseQueryValidator.validateLimit(
            kind: "limitToFirst",
            limit: limit,
            existingLimit: limitSpec
        )
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: orderBySpec,
            boundsSpec: boundsSpec,
            limitSpec: validated
        )
    }

    public func queryLimited(toLast limit: UInt) -> DatabaseQuery {
        return requireValidQuery { try validatedQueryLimited(toLast: limit) }
    }

    package func validatedQueryLimited(toLast limit: UInt) throws -> DatabaseQuery {
        let validated = try DatabaseQueryValidator.validateLimit(
            kind: "limitToLast",
            limit: limit,
            existingLimit: limitSpec
        )
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: orderBySpec,
            boundsSpec: boundsSpec,
            limitSpec: validated
        )
    }

    private func appendingValidatedBound(
        kind: String,
        value: Any?,
        childKey: String?
    ) throws -> DatabaseQuery {
        let bound = try DatabaseQueryValidator.validateBound(
            kind: kind,
            value: value,
            childKey: childKey,
            existingOrderBy: orderBySpec,
            existingBounds: boundsSpec
        )
        return DatabaseQuery(
            database: database,
            path: path,
            orderBySpec: orderBySpec,
            boundsSpec: boundsSpec + [bound],
            limitSpec: limitSpec
        )
    }

    private func requireValidQuery(_ build: () throws -> DatabaseQuery) -> DatabaseQuery {
        do {
            return try build()
        } catch {
            preconditionFailure("InvalidDatabaseQuery: \(error.localizedDescription)")
        }
    }

    // -- One-Shot Reads --

    public func getData() async throws -> DataSnapshot {
        try await getData(turn: database.takeTurn())
    }

    public func getData(
        completion: @escaping @Sendable (Error?, DataSnapshot?) -> Void
    ) {
        let turn = database.takeTurn()
        Task {
            do {
                let snap = try await getData(turn: turn)
                completion(nil, snap)
            } catch {
                completion(error, nil)
            }
        }
    }

    /// Reads the location, sent in the place `turn` holds.
    func getData(
        turn: OperationTurn,
        forTransaction: Bool = false,
        actAs explicitLens: AuthLens? = nil
    ) async throws -> DataSnapshot {
        database.markUsed()
        let client = database.bridgeClient
        if ConnectionInfo.isInfoPath(path) {
            // `.info` is answered here, so the turn is passed without sending anything.
            await client.pass(turn: turn)
            let connected = ConnectionInfo.currentlyConnected(database)
            return DataSnapshot(wire: ConnectionInfo.wire(at: path, connected: connected), ref: ref)
        }
        var params: [String: AnySendable] = [
            "path": .string(path)
        ]
        if forTransaction {
            params["transaction"] = .bool(true)
        } else if let qSpec = toQuerySpecAnySendable() {
            params["query"] = qSpec
        }
        let actAs = explicitLens ?? database.currentAuthLens()
        let wire = try await client.op(
            turn: turn,
            method: "rtdb.get",
            params: database.withInstance(params),
            actAs: actAs
        )
        return DataSnapshot(wire: wire, ref: ref)
    }

    private final class SingleEventGate: @unchecked Sendable {
        private let lock = NSLock()
        private var settled = false
        private var handle: UInt?
        private var pendingRemove = false

        func attach(handle: UInt, remove: (UInt) -> Void) {
            lock.lock()
            if pendingRemove {
                lock.unlock()
                remove(handle)
                return
            }
            self.handle = handle
            lock.unlock()
        }

        func claim() -> (won: Bool, handle: UInt?) {
            lock.lock()
            defer { lock.unlock() }
            if settled {
                return (false, nil)
            }
            settled = true
            pendingRemove = true
            let h = handle
            handle = nil
            return (true, h)
        }
    }

    public func observeSingleEvent(of eventType: DataEventType) async throws -> DataSnapshot {
        if eventType == .value {
            return try await getData()
        }
        let gate = SingleEventGate()
        final class ContBox: @unchecked Sendable {
            private let lock = NSLock()
            private var cont: CheckedContinuation<DataSnapshot, Error>?
            private var pendingResult: Result<DataSnapshot, Error>?
            func store(_ c: CheckedContinuation<DataSnapshot, Error>) {
                lock.lock()
                if let res = pendingResult {
                    pendingResult = nil
                    lock.unlock()
                    c.resume(with: res)
                    return
                }
                cont = c
                lock.unlock()
            }
            func finish(_ res: Result<DataSnapshot, Error>) {
                lock.lock()
                if let c = cont {
                    cont = nil
                    lock.unlock()
                    c.resume(with: res)
                    return
                }
                if pendingResult == nil {
                    pendingResult = res
                }
                lock.unlock()
            }
        }
        let contBox = ContBox()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                contBox.store(continuation)
                if Task.isCancelled {
                    let claimed = gate.claim()
                    if let h = claimed.handle {
                        self.removeObserver(withHandle: h)
                    }
                    if claimed.won {
                        contBox.finish(.failure(CancellationError()))
                    }
                    return
                }
                let handle = self.observe(eventType, with: { snap in
                    let claimed = gate.claim()
                    if let h = claimed.handle {
                        self.removeObserver(withHandle: h)
                    }
                    if claimed.won {
                        contBox.finish(.success(snap))
                    }
                }, withCancel: { error in
                    let claimed = gate.claim()
                    if let h = claimed.handle {
                        self.removeObserver(withHandle: h)
                    }
                    if claimed.won {
                        contBox.finish(.failure(error))
                    }
                })
                gate.attach(handle: handle) { self.removeObserver(withHandle: $0) }
            }
        } onCancel: {
            let claimed = gate.claim()
            if let h = claimed.handle {
                self.removeObserver(withHandle: h)
            }
            if claimed.won {
                contBox.finish(.failure(CancellationError()))
            }
        }
    }

    public func observeSingleEvent(
        of eventType: DataEventType,
        with block: @escaping @Sendable (DataSnapshot) -> Void,
        withCancel cancelBlock: (@Sendable (Error) -> Void)? = nil
    ) {
        if eventType == .value {
            getData { error, snapshot in
                if let error {
                    cancelBlock?(error)
                    return
                }
                if let snapshot {
                    block(snapshot)
                }
            }
            return
        }
        let gate = SingleEventGate()
        let handle = self.observe(eventType, with: { snap in
            let claimed = gate.claim()
            if let h = claimed.handle {
                self.removeObserver(withHandle: h)
            }
            if claimed.won {
                block(snap)
            }
        }, withCancel: { error in
            let claimed = gate.claim()
            if let h = claimed.handle {
                self.removeObserver(withHandle: h)
            }
            if claimed.won {
                cancelBlock?(error)
            }
        })
        gate.attach(handle: handle) { self.removeObserver(withHandle: $0) }
    }

    // -- Real-Time Listeners & AsyncStreams --

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
        let handle = database.viewCoordinator.registerObserver(
            database: database,
            path: path,
            orderBySpec: orderBySpec,
            querySpec: toQuerySpecAnySendable(),
            subscriptionTarget: toSubscriptionTargetAnySendable(),
            ref: ref,
            eventTypes: [eventType],
            onEvent: { event in
                block(event.snapshot, event.previousSiblingKey)
            },
            onCancel: cancelBlock
        )
        observerLock.lock()
        localObserverHandles.insert(handle)
        observerLock.unlock()
        return handle
    }

    private func observeAllChildEvents(
        with block: @escaping @Sendable (DatabaseChildEvent) -> Void,
        withCancel cancelBlock: (@Sendable (Error) -> Void)? = nil
    ) -> UInt {
        let handle = database.viewCoordinator.registerObserver(
            database: database,
            path: path,
            orderBySpec: orderBySpec,
            querySpec: toQuerySpecAnySendable(),
            subscriptionTarget: toSubscriptionTargetAnySendable(),
            ref: ref,
            eventTypes: [.childAdded, .childChanged, .childRemoved, .childMoved],
            onEvent: block,
            onCancel: cancelBlock
        )
        observerLock.lock()
        localObserverHandles.insert(handle)
        observerLock.unlock()
        return handle
    }

    public func removeObserver(withHandle handle: UInt) {
        observerLock.lock()
        localObserverHandles.remove(handle)
        observerLock.unlock()
        database.viewCoordinator.removeObserver(handle: handle)
    }

    public func removeAllObservers() {
        observerLock.lock()
        let handles = localObserverHandles
        localObserverHandles.removeAll()
        observerLock.unlock()
        database.viewCoordinator.removeObservers(handles: handles)
        database.viewCoordinator.removeAllObservers(path: path, querySpec: toQuerySpecAnySendable())
    }
}
