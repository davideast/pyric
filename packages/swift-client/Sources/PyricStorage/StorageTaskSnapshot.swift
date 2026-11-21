import Foundation

/// Immutable point-in-time view of a `StorageTask`, mirroring `StorageTaskSnapshot` (`13.2.0`).
open class StorageTaskSnapshot: NSObject, @unchecked Sendable {
    /// The `StorageTask` that produced this snapshot.
    public let task: StorageTask

    /// Object metadata associated with the task, when known.
    public let metadata: StorageMetadata?

    /// The `StorageReference` targeted by the task.
    public let reference: StorageReference

    /// Snapshot `Progress` reporting `completedUnitCount` and `totalUnitCount`.
    public let progress: Progress?

    /// Terminal error if the task failed or was cancelled, otherwise `nil`.
    public let error: (any Error)?

    /// Public `StorageTaskStatus` at the moment this snapshot was captured.
    public let status: StorageTaskStatus

    package let state: StorageTaskState

    package init(
        task: StorageTask,
        state: StorageTaskState,
        status: StorageTaskStatus,
        reference: StorageReference,
        metadata: StorageMetadata?,
        progress: Progress?,
        error: (any Error)?
    ) {
        self.task = task
        self.state = state
        self.status = status
        self.reference = reference
        self.metadata = metadata
        self.progress = progress
        self.error = error
        super.init()
    }

    override public var description: String {
        switch status {
        case .resume:
            return "<State: Resume>"
        case .progress:
            return "<State: Progress, Progress: \(String(describing: progress))>"
        case .pause:
            return "<State: Paused>"
        case .success:
            return "<State: Success>"
        case .failure:
            return "<State: Failed, Error: \(String(describing: error))>"
        case .unknown:
            return "<State: Unknown>"
        }
    }
}
