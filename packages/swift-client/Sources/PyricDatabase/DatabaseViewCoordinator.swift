import Foundation
import PyricFirestore

/// Coordinates Realtime Database observers per `(path, querySpec)` view so
/// concurrent `observe(_:)` and `childEvents` listeners share a single view
/// diff and receive events in Firebase `EventGenerator` order:
/// `childRemoved` -> `childAdded` -> `childMoved` -> `childChanged` -> `value`.
internal final class DatabaseViewCoordinator: @unchecked Sendable {
    internal struct ViewKey: Hashable, Sendable {
        let path: String
        let queryKey: String

        init(path: String, querySpec: AnySendable?) {
            self.path = path
            if let querySpec {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                if let data = try? encoder.encode(querySpec),
                   let str = String(data: data, encoding: .utf8) {
                    self.queryKey = str
                } else {
                    self.queryKey = String(describing: querySpec)
                }
            } else {
                self.queryKey = ""
            }
        }
    }

    fileprivate struct ObserverEntry: Sendable {
        let handle: UInt
        let onEvent: @Sendable (DatabaseChildEvent) -> Void
        let onCancel: (@Sendable (Error) -> Void)?
    }

    fileprivate enum ViewDelivery: Sendable {
        case initial(entry: ObserverEntry, events: [DatabaseChildEvent])
        case fanout(batches: [(entry: ObserverEntry, events: [DatabaseChildEvent])])
        case cancel(entries: [ObserverEntry], error: Error)
    }

    private final class RegistrationRecord {
        let entry: ObserverEntry
        let differ: SnapshotEvents

        init(entry: ObserverEntry, differ: SnapshotEvents) {
            self.entry = entry
            self.differ = differ
        }
    }

    private final class ActiveView: @unchecked Sendable {
        let key: ViewKey
        private let lock = NSLock()
        private var records: [RegistrationRecord] = []
        private var latestSnapshot: DataSnapshot?
        private var closed = false
        private let deliveryContinuation: AsyncStream<ViewDelivery>.Continuation
        private var deliveryTask: Task<Void, Never>?
        private var feedTask: Task<Void, Never>?
        private var feedCleanup: (@Sendable () -> Void)?

        init(key: ViewKey, coordinator: DatabaseViewCoordinator) {
            self.key = key
            var capturedContinuation: AsyncStream<ViewDelivery>.Continuation?
            let stream = AsyncStream<ViewDelivery> { continuation in
                capturedContinuation = continuation
            }
            self.deliveryContinuation = capturedContinuation!

            self.deliveryTask = Task { [weak coordinator] in
                for await item in stream {
                    if Task.isCancelled { break }
                    switch item {
                    case let .initial(entry, events):
                        for event in events {
                            guard coordinator?.isHandleActive(entry.handle) == true else { break }
                            entry.onEvent(event)
                        }
                    case let .fanout(batches):
                        for kind in SnapshotEvents.canonicalEventOrder {
                            for batch in batches {
                                for event in batch.events where event.type == kind {
                                    if coordinator?.isHandleActive(batch.entry.handle) == true {
                                        batch.entry.onEvent(event)
                                    }
                                }
                            }
                        }
                    case let .cancel(entries, error):
                        for entry in entries {
                            entry.onCancel?(error)
                        }
                    }
                }
            }
        }

        func startFeed(_ builder: (ActiveView) -> (task: Task<Void, Never>?, cleanup: (@Sendable () -> Void)?)) {
            let built = builder(self)
            lock.lock()
            if closed {
                lock.unlock()
                built.task?.cancel()
                built.cleanup?()
                return
            }
            feedTask = built.task
            feedCleanup = built.cleanup
            lock.unlock()
        }

        func addRegistration(
            entry: ObserverEntry,
            eventTypes: Set<DataEventType>,
            orderBySpec: [String: AnySendable]?
        ) -> Bool {
            lock.lock()
            if closed {
                lock.unlock()
                return false
            }
            let differ = SnapshotEvents(eventTypes: eventTypes, orderBySpec: orderBySpec)
            let record = RegistrationRecord(entry: entry, differ: differ)
            records.append(record)
            if let snap = latestSnapshot {
                let initialEvents = differ.collectEvents(for: snap)
                if !initialEvents.isEmpty {
                    deliveryContinuation.yield(.initial(entry: entry, events: initialEvents))
                }
            }
            lock.unlock()
            return true
        }

        func handleSnapshot(_ snap: DataSnapshot) {
            lock.lock()
            if closed {
                lock.unlock()
                return
            }
            latestSnapshot = snap
            var batches: [(entry: ObserverEntry, events: [DatabaseChildEvent])] = []
            batches.reserveCapacity(records.count)
            for record in records {
                let events = record.differ.collectEvents(for: snap)
                if !events.isEmpty {
                    batches.append((entry: record.entry, events: events))
                }
            }
            if !batches.isEmpty {
                deliveryContinuation.yield(.fanout(batches: batches))
            }
            lock.unlock()
        }

        func handleError(_ error: Error) -> [UInt] {
            lock.lock()
            if closed {
                lock.unlock()
                return []
            }
            closed = true
            let entries = records.map(\.entry)
            let handles = entries.map(\.handle)
            records.removeAll()
            latestSnapshot = nil
            deliveryContinuation.yield(.cancel(entries: entries, error: error))
            deliveryContinuation.finish()
            let fTask = feedTask
            let cleanup = feedCleanup
            feedTask = nil
            feedCleanup = nil
            lock.unlock()
            fTask?.cancel()
            cleanup?()
            return handles
        }

        func removeHandles(_ targetHandles: Set<UInt>) -> Bool {
            lock.lock()
            records.removeAll { targetHandles.contains($0.entry.handle) }
            let becameEmpty = records.isEmpty
            var fTask: Task<Void, Never>?
            var dTask: Task<Void, Never>?
            var cleanup: (@Sendable () -> Void)?
            if becameEmpty && !closed {
                closed = true
                latestSnapshot = nil
                deliveryContinuation.finish()
                fTask = feedTask
                dTask = deliveryTask
                cleanup = feedCleanup
                feedTask = nil
                deliveryTask = nil
                feedCleanup = nil
            }
            lock.unlock()
            fTask?.cancel()
            cleanup?()
            dTask?.cancel()
            return becameEmpty
        }

        func allHandles() -> [UInt] {
            lock.lock()
            defer { lock.unlock() }
            return records.map(\.entry.handle)
        }

        func shutdown() {
            lock.lock()
            closed = true
            records.removeAll()
            latestSnapshot = nil
            deliveryContinuation.finish()
            let fTask = feedTask
            let dTask = deliveryTask
            let cleanup = feedCleanup
            feedTask = nil
            deliveryTask = nil
            feedCleanup = nil
            lock.unlock()
            fTask?.cancel()
            cleanup?()
            dTask?.cancel()
        }
    }

    private let lock = NSLock()
    private var nextHandle: UInt = 1
    private var viewsByKey: [ViewKey: ActiveView] = [:]
    private var keyByHandle: [UInt: ViewKey] = [:]

    internal func registerObserver(
        database: Database,
        path: String,
        orderBySpec: [String: AnySendable]?,
        querySpec: AnySendable?,
        subscriptionTarget: AnySendable,
        ref: DatabaseReference,
        eventTypes: Set<DataEventType>,
        onEvent: @escaping @Sendable (DatabaseChildEvent) -> Void,
        onCancel: (@Sendable (Error) -> Void)?
    ) -> UInt {
        database.markUsed()
        let key = ViewKey(path: path, querySpec: querySpec)

        while true {
            lock.lock()
            let handle = nextHandle
            nextHandle += 1
            let entry = ObserverEntry(handle: handle, onEvent: onEvent, onCancel: onCancel)
            if let existing = viewsByKey[key] {
                keyByHandle[handle] = key
                lock.unlock()
                if existing.addRegistration(entry: entry, eventTypes: eventTypes, orderBySpec: orderBySpec) {
                    return handle
                }
                lock.lock()
                keyByHandle.removeValue(forKey: handle)
                lock.unlock()
                continue
            }

            let created = ActiveView(key: key, coordinator: self)
            _ = created.addRegistration(entry: entry, eventTypes: eventTypes, orderBySpec: orderBySpec)
            created.startFeed { [weak self] activeView in
                Self.makeFeedTask(
                    coordinator: self,
                    activeView: activeView,
                    database: database,
                    path: path,
                    subscriptionTarget: subscriptionTarget,
                    queryRef: ref
                )
            }
            viewsByKey[key] = created
            keyByHandle[handle] = key
            lock.unlock()
            return handle
        }
    }

    internal func isHandleActive(_ handle: UInt) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return keyByHandle[handle] != nil
    }

    internal func removeObserver(handle: UInt) {
        removeObservers(handles: [handle])
    }

    internal func removeObservers(handles: Set<UInt>) {
        guard !handles.isEmpty else { return }
        var affectedViews: [ViewKey: Set<UInt>] = [:]
        lock.lock()
        for handle in handles {
            if let key = keyByHandle.removeValue(forKey: handle) {
                affectedViews[key, default: []].insert(handle)
            }
        }
        let targetViews: [(ViewKey, ActiveView, Set<UInt>)] = affectedViews.compactMap { key, hSet in
            guard let view = viewsByKey[key] else { return nil }
            return (key, view, hSet)
        }
        lock.unlock()

        for (key, view, hSet) in targetViews {
            if view.removeHandles(hSet) {
                lock.lock()
                if let current = viewsByKey[key], current === view {
                    viewsByKey.removeValue(forKey: key)
                }
                lock.unlock()
            }
        }
    }

    internal func removeAllObservers(path: String, querySpec: AnySendable?) {
        let key = ViewKey(path: path, querySpec: querySpec)
        lock.lock()
        guard let view = viewsByKey[key] else {
            lock.unlock()
            return
        }
        lock.unlock()
        let handles = Set(view.allHandles())
        removeObservers(handles: handles)
    }

    internal func shutdown() {
        lock.lock()
        let views = Array(viewsByKey.values)
        viewsByKey.removeAll()
        keyByHandle.removeAll()
        lock.unlock()
        for view in views {
            view.shutdown()
        }
    }

    private func evictErroredView(_ view: ActiveView, error: Error) {
        let removedHandles = view.handleError(error)
        lock.lock()
        if let current = viewsByKey[view.key], current === view {
            viewsByKey.removeValue(forKey: view.key)
        }
        for handle in removedHandles {
            keyByHandle.removeValue(forKey: handle)
        }
        lock.unlock()
    }

    private static func makeFeedTask(
        coordinator: DatabaseViewCoordinator?,
        activeView: ActiveView,
        database: Database,
        path: String,
        subscriptionTarget: AnySendable,
        queryRef: DatabaseReference
    ) -> (task: Task<Void, Never>?, cleanup: (@Sendable () -> Void)?) {
        if ConnectionInfo.isInfoPath(path) {
            final class WireDedup: @unchecked Sendable {
                private let lock = NSLock()
                private var lastWire: AnySendable?
                func shouldEmit(_ wire: AnySendable) -> Bool {
                    lock.lock()
                    defer { lock.unlock() }
                    if wire == lastWire { return false }
                    lastWire = wire
                    return true
                }
            }
            let dedup = WireDedup()
            let hub = database.connectionInfoHub
            let token = hub.addObserver { [weak activeView] connected in
                guard let activeView else { return }
                for wire in [ConnectionInfo.wire(at: path, connected: connected)] {
                    guard wire["exists"]?.boolValue == true else { continue }
                    guard dedup.shouldEmit(wire) else { continue }
                    activeView.handleSnapshot(DataSnapshot(wire: wire, ref: queryRef))
                }
            }
            return (nil, { hub.removeObserver(token) })
        }

        // Open the lens stream and initial bridge subscription synchronously so
        // `observe(...)` reserves its admission turn before returning (D7, S16).
        let initialLens = database.currentAuthLens()
        let lensStream = database.authLensStream
        let initialIterator = database.bridgeClient.subscribe(
            target: subscriptionTarget,
            actAs: initialLens.toAnySendable()
        ).makeAsyncIterator()

        final class IteratorBox: @unchecked Sendable {
            private let lock = NSLock()
            private var current: PyricSubscriptionStream.Iterator?
            private var cancelled = false

            init(_ initial: PyricSubscriptionStream.Iterator) {
                self.current = initial
            }

            func replace(with next: PyricSubscriptionStream.Iterator) -> Bool {
                lock.lock()
                let prev = current
                if cancelled {
                    current = nil
                    lock.unlock()
                    prev?.cancel()
                    next.cancel()
                    return false
                }
                current = next
                lock.unlock()
                prev?.cancel()
                return true
            }

            func cancelAll() {
                lock.lock()
                cancelled = true
                let prev = current
                current = nil
                lock.unlock()
                prev?.cancel()
            }
        }

        let iteratorBox = IteratorBox(initialIterator)

        let task = Task { [weak coordinator] in
            var activeLens = initialLens
            var activeChild = Self.startSnapshotConsumer(
                iterator: initialIterator,
                coordinator: coordinator,
                activeView: activeView,
                queryRef: queryRef
            )
            defer { activeChild.cancel() }

            for await nextLens in lensStream {
                if Task.isCancelled { break }
                if nextLens == activeLens { continue }
                activeLens = nextLens
                activeChild.cancel()
                let nextIterator = database.bridgeClient.subscribe(
                    target: subscriptionTarget,
                    actAs: nextLens.toAnySendable()
                ).makeAsyncIterator()
                guard iteratorBox.replace(with: nextIterator) else { break }
                activeChild = Self.startSnapshotConsumer(
                    iterator: nextIterator,
                    coordinator: coordinator,
                    activeView: activeView,
                    queryRef: queryRef
                )
            }
        }
        return (task, { iteratorBox.cancelAll() })
    }

    private static func startSnapshotConsumer(
        iterator: PyricSubscriptionStream.Iterator,
        coordinator: DatabaseViewCoordinator?,
        activeView: ActiveView,
        queryRef: DatabaseReference
    ) -> Task<Void, Never> {
        Task { [weak coordinator] in
            do {
                while let wireSnap = try await iterator.next() {
                    if Task.isCancelled { break }
                    if let errDict = wireSnap["__error"] {
                        let msg = errDict["message"]?.stringValue ?? "Permission denied"
                        coordinator?.evictErroredView(
                            activeView,
                            error: PyricBridgeError.permissionDenied(msg)
                        )
                        return
                    }
                    activeView.handleSnapshot(DataSnapshot(wire: wireSnap, ref: queryRef))
                }
            } catch {
                if !Task.isCancelled {
                    coordinator?.evictErroredView(activeView, error: error)
                }
            }
        }
    }
}
