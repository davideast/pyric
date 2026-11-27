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

    private let lock = NSLock()
    private var nextHandle: UInt = 1
    private var viewsByKey: [ViewKey: ActiveView] = [:]
    private var keyByHandle: [UInt: ViewKey] = [:]
    private var entriesByHandle: [UInt: ObserverEntry] = [:]

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

        let currentLens: AuthLens = ConnectionInfo.isInfoPath(path) ? .anon : database.currentAuthLens()
        while true {
            lock.lock()
            let handle = nextHandle
            nextHandle += 1
            let entry = ObserverEntry(handle: handle, onEvent: onEvent, onCancel: onCancel)
            if let existing = viewsByKey[key] {
                keyByHandle[handle] = key
                entriesByHandle[handle] = entry
                lock.unlock()
                if existing.addRegistration(entry: entry, eventTypes: eventTypes, orderBySpec: orderBySpec, currentLens: currentLens) {
                    return handle
                }
                lock.lock()
                keyByHandle.removeValue(forKey: handle)
                entriesByHandle.removeValue(forKey: handle)
                lock.unlock()
                continue
            }

            let created = ActiveView(key: key, deliveryQueue: database.bridgeClient.deliveryQueue)
            _ = created.addRegistration(entry: entry, eventTypes: eventTypes, orderBySpec: orderBySpec, currentLens: currentLens)
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
            entriesByHandle[handle] = entry
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
        var removedEntriesByHandle: [UInt: ObserverEntry] = [:]
        lock.lock()
        for handle in handles {
            if let entry = entriesByHandle.removeValue(forKey: handle) {
                removedEntriesByHandle[handle] = entry
            }
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
            let result = view.removeHandles(hSet)
            for entry in result.removed {
                removedEntriesByHandle[entry.handle] = entry
            }
            if result.becameEmpty {
                lock.lock()
                if let current = viewsByKey[key], current === view {
                    viewsByKey.removeValue(forKey: key)
                }
                lock.unlock()
            }
        }
        // Synchronize with any in-flight event or cancel callback outside all locks (D9, S27).
        for entry in removedEntriesByHandle.values {
            entry.cancel()
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
        let entries = Array(entriesByHandle.values)
        viewsByKey.removeAll()
        keyByHandle.removeAll()
        entriesByHandle.removeAll()
        lock.unlock()
        for view in views {
            view.shutdown()
        }
        for entry in entries {
            entry.cancel()
        }
    }

    private func releaseEntry(handle: UInt) {
        lock.lock()
        entriesByHandle.removeValue(forKey: handle)
        lock.unlock()
    }

    private func evictErroredView(_ view: ActiveView, error: Error) {
        let removedHandles = view.handleError(error) { [weak self] handle in
            self?.releaseEntry(handle: handle)
        }
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
                    activeView.handleSnapshot(DataSnapshot(wire: wire, ref: queryRef), lens: .anon)
                }
            }
            return (nil, { hub.removeObserver(token) })
        }

        // Open the lens stream and initial bridge subscription synchronously so
        // `observe(...)` reserves its admission turn before returning (D7, S16)
        // and delivers snapshots on the client's serial delivery queue (D8, S20).
        let initialLens = database.currentAuthLens()
        let lensStream = database.authLensStream

        final class HandleBox: @unchecked Sendable {
            private let lock = NSLock()
            private var activeToken: UUID?
            private var currentHandle: OrderedSubscriptionHandle?
            private var cancelled = false

            func isActive(token: UUID) -> Bool {
                lock.lock()
                defer { lock.unlock() }
                return !cancelled && activeToken == token
            }

            func begin(token: UUID) -> Bool {
                lock.lock()
                let prev = currentHandle
                currentHandle = nil
                if cancelled {
                    activeToken = nil
                    lock.unlock()
                    prev?.cancel()
                    return false
                }
                activeToken = token
                lock.unlock()
                prev?.cancel()
                return true
            }

            func attach(token: UUID, handle: OrderedSubscriptionHandle) -> Bool {
                lock.lock()
                if cancelled || activeToken != token {
                    lock.unlock()
                    handle.cancel()
                    return false
                }
                let prev = currentHandle
                currentHandle = handle
                lock.unlock()
                prev?.cancel()
                return true
            }

            func cancelAll() {
                lock.lock()
                cancelled = true
                activeToken = nil
                let prev = currentHandle
                currentHandle = nil
                lock.unlock()
                prev?.cancel()
            }
        }

        let handleBox = HandleBox()
        let isRecoverableDenial: @Sendable (Error) -> Bool = { error in
            guard let bridgeErr = error as? PyricBridgeError else { return false }
            return bridgeErr.denialContext != nil
                || bridgeErr.code == .permissionDenied
                || bridgeErr.code == .unauthenticated
        }
        let openForLens: @Sendable (AuthLens) -> Bool = { [weak coordinator] lens in
            activeView.clearLatestSnapshot()
            let token = UUID()
            guard handleBox.begin(token: token) else { return false }
            let capturedCoordinator = coordinator
            let handle = database.bridgeClient.openOrderedSubscription(
                target: subscriptionTarget,
                actAs: lens.toAnySendable(),
                dispatchOnDeliveryQueue: false,
                onEvent: { event in
                    guard handleBox.isActive(token: token) else { return }
                    guard case .value(let wireSnap) = event else { return }
                    if let errDict = wireSnap["__error"] {
                        let msg = errDict["message"]?.stringValue ?? "Permission denied"
                        activeView.deliverRecoverableDenial(PyricBridgeError.permissionDenied(msg), lens: lens)
                        return
                    }
                    activeView.handleSnapshot(DataSnapshot(wire: wireSnap, ref: queryRef), lens: lens)
                },
                onFinish: { [weak capturedCoordinator] error in
                    guard let error, handleBox.isActive(token: token) else { return }
                    if isRecoverableDenial(error) {
                        activeView.deliverRecoverableDenial(error, lens: lens)
                        return
                    }
                    capturedCoordinator?.evictErroredView(activeView, error: error)
                }
            )
            return handleBox.attach(token: token, handle: handle)
        }

        _ = openForLens(initialLens)

        let task = Task {
            var activeLens = initialLens
            for await nextLens in lensStream {
                if Task.isCancelled { break }
                if nextLens == activeLens { continue }
                activeLens = nextLens
                guard openForLens(nextLens) else { break }
            }
        }
        return (task, { handleBox.cancelAll() })
    }
}
