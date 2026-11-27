import Foundation
import PyricFirestore

extension DatabaseViewCoordinator {
    internal final class ObserverEntry: @unchecked Sendable {
        let handle: UInt
        private let onEvent: @Sendable (DatabaseChildEvent) -> Void
        private let onCancel: (@Sendable (Error) -> Void)?
        private let stateLock = NSLock()
        private let callbackLock = NSRecursiveLock()
        private var cancelled = false

        init(
            handle: UInt,
            onEvent: @escaping @Sendable (DatabaseChildEvent) -> Void,
            onCancel: (@Sendable (Error) -> Void)?
        ) {
            self.handle = handle
            self.onEvent = onEvent
            self.onCancel = onCancel
        }

        private var isCancelled: Bool {
            stateLock.lock()
            defer { stateLock.unlock() }
            return cancelled
        }

        func cancel() {
            stateLock.lock()
            cancelled = true
            stateLock.unlock()
            callbackLock.lock()
            callbackLock.unlock()
        }

        func deliverEvent(_ event: DatabaseChildEvent) {
            callbackLock.lock()
            defer { callbackLock.unlock() }
            guard !isCancelled else { return }
            onEvent(event)
        }

        func deliverCancel(_ error: Error) {
            callbackLock.lock()
            defer { callbackLock.unlock() }
            guard !isCancelled else { return }
            onCancel?(error)
        }
    }

    private final class RegistrationRecord {
        let entry: ObserverEntry
        let differ: SnapshotEvents

        init(entry: ObserverEntry, differ: SnapshotEvents) {
            self.entry = entry
            self.differ = differ
        }
    }

    internal final class ActiveView: @unchecked Sendable {
        let key: ViewKey
        private let deliveryQueue: DispatchQueue
        private let lock = NSLock()
        private var records: [RegistrationRecord] = []
        private var latestSnapshot: DataSnapshot?
        private var latestSnapshotLens: AuthLens?
        private var latestDenial: (error: Error, lens: AuthLens)?
        private var closed = false
        private var feedTask: Task<Void, Never>?
        private var feedCleanup: (@Sendable () -> Void)?

        init(key: ViewKey, deliveryQueue: DispatchQueue) {
            self.key = key
            self.deliveryQueue = deliveryQueue
        }

        private static func deliverFanout(
            _ batches: [(entry: ObserverEntry, events: [DatabaseChildEvent])]
        ) {
            for kind in SnapshotEvents.canonicalEventOrder {
                for batch in batches {
                    for event in batch.events where event.type == kind {
                        batch.entry.deliverEvent(event)
                    }
                }
            }
        }

        func startFeed(
            _ builder: (ActiveView) -> (task: Task<Void, Never>?, cleanup: (@Sendable () -> Void)?)
        ) {
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

        func clearLatestSnapshot() {
            lock.lock()
            latestSnapshot = nil
            latestSnapshotLens = nil
            latestDenial = nil
            lock.unlock()
        }

        func addRegistration(
            entry: ObserverEntry,
            eventTypes: Set<DataEventType>,
            orderBySpec: [String: AnySendable]?,
            currentLens: AuthLens
        ) -> Bool {
            lock.lock()
            if closed {
                lock.unlock()
                return false
            }
            if latestSnapshot != nil && latestSnapshotLens != currentLens {
                latestSnapshot = nil
                latestSnapshotLens = nil
            }
            if let denial = latestDenial, denial.lens != currentLens {
                latestDenial = nil
            }
            let differ = SnapshotEvents(eventTypes: eventTypes, orderBySpec: orderBySpec)
            let record = RegistrationRecord(entry: entry, differ: differ)
            records.append(record)
            if let snap = latestSnapshot {
                let initialEvents = differ.collectEvents(for: snap)
                if !initialEvents.isEmpty {
                    // Enqueue under `lock` so initial delivery stays strictly
                    // ordered ahead of any subsequent snapshot diff (D8, S20).
                    deliveryQueue.async {
                        for event in initialEvents {
                            entry.deliverEvent(event)
                        }
                    }
                }
            } else if let denial = latestDenial, denial.lens == currentLens {
                let denialError = denial.error
                deliveryQueue.async {
                    entry.deliverCancel(denialError)
                }
            }
            lock.unlock()
            return true
        }

        func handleSnapshot(_ snap: DataSnapshot, lens: AuthLens) {
            lock.lock()
            if closed {
                lock.unlock()
                return
            }
            latestSnapshot = snap
            latestSnapshotLens = lens
            latestDenial = nil
            var batches: [(entry: ObserverEntry, events: [DatabaseChildEvent])] = []
            batches.reserveCapacity(records.count)
            for record in records {
                let events = record.differ.collectEvents(for: snap)
                if !events.isEmpty {
                    batches.append((entry: record.entry, events: events))
                }
            }
            if !batches.isEmpty {
                let pendingBatches = batches
                deliveryQueue.async {
                    Self.deliverFanout(pendingBatches)
                }
            }
            lock.unlock()
        }

        func deliverRecoverableDenial(_ error: Error, lens: AuthLens) {
            lock.lock()
            if closed {
                lock.unlock()
                return
            }
            latestSnapshot = nil
            latestSnapshotLens = nil
            latestDenial = (error, lens)
            let entries = records.map(\.entry)
            if !entries.isEmpty {
                deliveryQueue.async {
                    for entry in entries { entry.deliverCancel(error) }
                }
            }
            lock.unlock()
        }

        func handleError(
            _ error: Error,
            onEntryReleased: (@Sendable (UInt) -> Void)? = nil
        ) -> [UInt] {
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
            latestSnapshotLens = nil
            latestDenial = nil
            if !entries.isEmpty {
                deliveryQueue.async {
                    for entry in entries {
                        entry.deliverCancel(error)
                        onEntryReleased?(entry.handle)
                    }
                }
            }
            let fTask = feedTask
            let cleanup = feedCleanup
            feedTask = nil
            feedCleanup = nil
            lock.unlock()
            fTask?.cancel()
            cleanup?()
            return handles
        }

        func removeHandles(_ targetHandles: Set<UInt>) -> (becameEmpty: Bool, removed: [ObserverEntry]) {
            lock.lock()
            var removed: [ObserverEntry] = []
            records.removeAll { record in
                if targetHandles.contains(record.entry.handle) {
                    removed.append(record.entry)
                    return true
                }
                return false
            }
            let becameEmpty = records.isEmpty
            var fTask: Task<Void, Never>?
            var cleanup: (@Sendable () -> Void)?
            if becameEmpty && !closed {
                closed = true
                latestSnapshot = nil
                latestSnapshotLens = nil
                latestDenial = nil
                fTask = feedTask
                cleanup = feedCleanup
                feedTask = nil
                feedCleanup = nil
            }
            lock.unlock()
            fTask?.cancel()
            cleanup?()
            return (becameEmpty, removed)
        }

        func allHandles() -> [UInt] {
            lock.lock()
            defer { lock.unlock() }
            return records.map(\.entry.handle)
        }

        func shutdown() {
            lock.lock()
            closed = true
            let removed = records.map(\.entry)
            records.removeAll()
            latestSnapshot = nil
            latestSnapshotLens = nil
            latestDenial = nil
            let fTask = feedTask
            let cleanup = feedCleanup
            feedTask = nil
            feedCleanup = nil
            lock.unlock()
            fTask?.cancel()
            cleanup?()
            for entry in removed {
                entry.cancel()
            }
        }
    }
}
