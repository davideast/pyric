import Foundation

/// Observable base class for `StorageUploadTask` and `StorageDownloadTask`,
/// mirroring `StorageObservableTask` (`13.2.0`).
open class StorageObservableTask: StorageTask, @unchecked Sendable {
    private final class ObserverBox: @unchecked Sendable {
        private let lock = NSLock()
        private var removed = false
        let handler: @Sendable (StorageTaskSnapshot) -> Void

        init(_ handler: @escaping @Sendable (StorageTaskSnapshot) -> Void) {
            self.handler = handler
        }

        var isRemoved: Bool {
            lock.lock()
            defer { lock.unlock() }
            return removed
        }

        func markRemoved() {
            lock.lock()
            removed = true
            lock.unlock()
        }
    }

    private var observersByStatus: [StorageTaskStatus: [StorageHandle: ObserverBox]] = [:]
    private var orderedHandlesByStatus: [StorageTaskStatus: [StorageHandle]] = [:]
    private var handleToStatus: [StorageHandle: StorageTaskStatus] = [:]

    /// Registers an observer for `status`, returning an opaque `StorageHandle` that can be
    /// passed to `removeObserver(withHandle:)`.
    ///
    /// Mirrors `FirebaseStorage 13.2.0`:
    /// - Observing `.unknown` triggers a precondition failure (`Invalid observer status requested`).
    /// - If the task is already in a matching active or terminal state, `handler` is invoked
    ///   asynchronously on `callbackQueue` with the current snapshot.
    /// - Observers registered after the task reaches a terminal state (`.success` or `.failure`)
    ///   fire once (if matching) and are not retained in the dictionary.
    @discardableResult
    open func observe(
        _ status: StorageTaskStatus,
        handler: @escaping @Sendable (StorageTaskSnapshot) -> Void
    ) -> StorageHandle {
        precondition(status != .unknown, "Invalid observer status requested")

        let handle = UUID().uuidString
        let box = ObserverBox(handler)

        let immediateSnapshot: StorageTaskSnapshot? = {
            stateLock.lock()
            defer { stateLock.unlock() }

            let currentState = _state
            var replayStatus: StorageTaskStatus?
            switch status {
            case .pause:
                if currentState == .paused || currentState == .pausing {
                    replayStatus = .pause
                }
            case .resume:
                if currentState == .running || currentState == .resuming {
                    replayStatus = .resume
                }
            case .progress:
                if currentState == .running || currentState == .progress || currentState == .resuming {
                    replayStatus = .progress
                }
            case .success:
                if currentState == .success {
                    replayStatus = .success
                }
            case .failure:
                if currentState == .failed || currentState == .cancelled {
                    replayStatus = .failure
                }
            case .unknown:
                break
            }

            if !currentState.isTerminal {
                var statusDict = observersByStatus[status] ?? [:]
                statusDict[handle] = box
                observersByStatus[status] = statusDict
                orderedHandlesByStatus[status, default: []].append(handle)
                handleToStatus[handle] = status
            }

            if let replayStatus {
                return snapshotUnderLock(overrideStatus: replayStatus)
            }
            return nil
        }()

        if let immediateSnapshot {
            dispatchCallback {
                guard !box.isRemoved else { return }
                box.handler(immediateSnapshot)
            }
        }
        return handle
    }

    /// Removes the single observer associated with `handle`.
    open func removeObserver(withHandle handle: StorageHandle) {
        let removedBox: ObserverBox? = {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard let status = handleToStatus.removeValue(forKey: handle) else {
                return nil
            }
            let box = observersByStatus[status]?.removeValue(forKey: handle)
            orderedHandlesByStatus[status]?.removeAll { $0 == handle }
            return box
        }()
        removedBox?.markRemoved()
    }

    /// Removes all observers registered for `status`.
    open func removeAllObservers(for status: StorageTaskStatus) {
        let removedBoxes: [ObserverBox] = {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard let dict = observersByStatus.removeValue(forKey: status) else {
                return []
            }
            orderedHandlesByStatus.removeValue(forKey: status)
            for key in dict.keys {
                handleToStatus.removeValue(forKey: key)
            }
            return Array(dict.values)
        }()
        for box in removedBoxes {
            box.markRemoved()
        }
    }

    /// Removes all observers across all `StorageTaskStatus` values.
    open func removeAllObservers() {
        let removedBoxes: [ObserverBox] = {
            stateLock.lock()
            defer { stateLock.unlock() }
            let all = observersByStatus.values.flatMap(\.values)
            observersByStatus.removeAll()
            orderedHandlesByStatus.removeAll()
            handleToStatus.removeAll()
            return all
        }()
        for box in removedBoxes {
            box.markRemoved()
        }
    }

    package func fireObservers(
        for status: StorageTaskStatus,
        snapshot: StorageTaskSnapshot,
        clearIfTerminal: Bool = false
    ) {
        let boxes: [ObserverBox] = {
            stateLock.lock()
            defer { stateLock.unlock() }
            let handles = orderedHandlesByStatus[status] ?? []
            let statusMap = observersByStatus[status] ?? [:]
            let matched = handles.compactMap { statusMap[$0] }
            if clearIfTerminal {
                observersByStatus.removeAll()
                orderedHandlesByStatus.removeAll()
                handleToStatus.removeAll()
            }
            return matched
        }()

        guard !boxes.isEmpty else { return }
        dispatchCallback {
            for box in boxes where !box.isRemoved {
                box.handler(snapshot)
            }
        }
    }
}
