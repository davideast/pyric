import Foundation

/// Handle returned when registering an observer on a `StorageObservableTask`.
public typealias StorageHandle = String

/// Observable status of a `StorageTask`, matching `FIRStorageTaskStatus` in `FirebaseStorage 13.2.0`.
public enum StorageTaskStatus: Int, Sendable, Equatable, Hashable {
    case unknown = 0
    case resume = 1
    case progress = 2
    case pause = 3
    case success = 4
    case failure = 5
}

/// Internal fine-grained lifecycle state of a `StorageTask`.
package enum StorageTaskState: Sendable, Equatable {
    case unknown
    case queueing
    case running
    case progress
    case pausing
    case paused
    case resuming
    case completing
    case success
    case failing
    case failed
    case cancelled

    package var publicStatus: StorageTaskStatus {
        switch self {
        case .queueing, .running, .resuming:
            return .resume
        case .progress:
            return .progress
        case .pausing, .paused:
            return .pause
        case .completing, .success:
            return .success
        case .failing, .failed, .cancelled:
            return .failure
        case .unknown:
            return .unknown
        }
    }

    package var isTerminal: Bool {
        switch self {
        case .success, .failed, .cancelled:
            return true
        default:
            return false
        }
    }
}

/// Lifecycle control contract for `StorageUploadTask` and `StorageDownloadTask`,
/// matching `FIRStorageTaskManagement` in `FirebaseStorage 13.2.0`.
public protocol StorageTaskManagement: NSObjectProtocol {
    func enqueue()
    func pause()
    func cancel()
    func resume()
}

/// Dispatches completion and observer callbacks on `Storage.callbackQueue` without
/// deadlocking `swift test` cooperative threads when `.main` has no active RunLoop.
package enum StorageCallbackDispatcher {
    private static let fallbackQueue = DispatchQueue(label: "dev.pyric.storage.callback-fallback")

    package static func dispatch(
        on queue: DispatchQueue,
        _ block: @escaping @Sendable () -> Void
    ) {
        #if os(macOS)
        if queue === DispatchQueue.main {
            fallbackQueue.async(execute: block)
            return
        }
        #elseif os(Linux)
        if queue === DispatchQueue.main || queue.label == DispatchQueue.main.label {
            fallbackQueue.async(execute: block)
            return
        }
        #endif
        queue.async(execute: block)
    }
}

/// Base class for controllable and observable Storage transfer tasks, mirroring `StorageTask` (`13.2.0`).
open class StorageTask: NSObject, @unchecked Sendable {
    package let stateLock = NSLock()
    package var _state: StorageTaskState = .queueing
    package var _metadata: StorageMetadata?
    package var _error: (any Error)?
    package var _completedBytes: Int64 = 0
    package var _totalBytes: Int64 = 0

    package let reference: StorageReference
    package let callbackQueue: DispatchQueue

    /// Thread-safe point-in-time snapshot of the task's current state and progress.
    public var snapshot: StorageTaskSnapshot {
        stateLock.lock()
        defer { stateLock.unlock() }
        return snapshotUnderLock()
    }

    package init(
        reference: StorageReference,
        callbackQueue: DispatchQueue,
        initialMetadata: StorageMetadata? = nil,
        totalBytes: Int64 = 0
    ) {
        self.reference = reference
        self.callbackQueue = callbackQueue
        self._metadata = initialMetadata
        self._totalBytes = max(0, totalBytes)
        super.init()
    }

    package func snapshotUnderLock(overrideStatus: StorageTaskStatus? = nil) -> StorageTaskSnapshot {
        let total = max(0, _totalBytes)
        let completed = min(max(0, _completedBytes), total)
        let progressCopy = Progress(totalUnitCount: total)
        progressCopy.completedUnitCount = completed
        let metadataCopy = _metadata.flatMap { $0.copy() as? StorageMetadata } ?? _metadata
        let resolvedStatus = overrideStatus ?? _state.publicStatus
        return StorageTaskSnapshot(
            task: self,
            state: _state,
            status: resolvedStatus,
            reference: reference,
            metadata: metadataCopy,
            progress: progressCopy,
            error: _error
        )
    }

    package func dispatchCallback(_ block: @escaping @Sendable () -> Void) {
        StorageCallbackDispatcher.dispatch(on: callbackQueue, block)
    }
}
