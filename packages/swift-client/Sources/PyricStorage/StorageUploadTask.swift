import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import PyricFirestore

/// Controllable and observable upload task supporting in-memory `Data` and file `URL` sources,
/// chunked resumable transfers, progress snapshots, `pause()`, `resume()`, and `cancel()`.
open class StorageUploadTask: StorageObservableTask, StorageTaskManagement, @unchecked Sendable {
    package static let defaultResumableChunkBytes: Int = 256 * 1024

    package enum UploadSource: Sendable {
        case data(Data)
        case file(URL)
    }

    package struct CommittedOutcome: Sendable {
        package let metadata: StorageMetadata
        package let rollbackToken: String?
    }

    package let source: UploadSource
    package let requestedMetadata: StorageMetadata?
    package let completion: (@Sendable (StorageMetadata?, Error?) -> Void)?
    package let gate = StorageTransferGate()

    package var hasEnqueued = false
    package var completionFired = false
    package var stagedUploadId: String?
    package var inFlightCommitTask: Task<CommittedOutcome, Error>?
    package var heldCommitOutcome: Result<CommittedOutcome, Error>?

    package init(
        reference: StorageReference,
        source: UploadSource,
        metadata: StorageMetadata?,
        completion: (@Sendable (StorageMetadata?, Error?) -> Void)?
    ) {
        self.source = source
        self.requestedMetadata = metadata.flatMap { $0.copy() as? StorageMetadata } ?? metadata
        self.completion = completion

        let initialSize: Int64
        switch source {
        case .data(let bytes):
            initialSize = Int64(bytes.count)
        case .file(let fileURL):
            if fileURL.isFileURL,
               let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path) {
                initialSize = Self.fileByteSize(from: attrs)
            } else {
                initialSize = 0
            }
        }

        let seedMeta = Self.buildInitialSnapshotMetadata(
            reference: reference,
            requested: metadata,
            source: source,
            size: initialSize
        )
        super.init(
            reference: reference,
            callbackQueue: reference.storage.callbackQueue,
            initialMetadata: seedMeta,
            totalBytes: initialSize
        )
    }

    /// Starts execution of the upload task if not already enqueued.
    open func enqueue() {
        let shouldStart: Bool = {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard !hasEnqueued, !_state.isTerminal else {
                return false
            }
            hasEnqueued = true
            if _state == .queueing {
                _state = .running
            }
            return true
        }()
        guard shouldStart else { return }

        reference.storage.markUsed()
        let client = reference.storage.bridgeClient
        let turn = client.takeTurn()
        let actAs = reference.storage.activeAuthLens()
        let configuredChunk = reference.storage.uploadChunkSizeBytes
        let timeout = reference.storage.maxUploadRetryTime

        let resumeSnap: StorageTaskSnapshot? = {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard _state == .running else { return nil }
            return snapshotUnderLock(overrideStatus: .resume)
        }()
        if let resumeSnap {
            fireObservers(for: .resume, snapshot: resumeSnap)
        }

        Task {
            await self.runUpload(
                client: client,
                turn: turn,
                actAs: actAs,
                configuredChunkSize: configuredChunk,
                timeout: timeout
            )
        }
    }

    /// Pauses an active in-progress upload between or during chunk transfers.
    open func pause() {
        let pauseSnapshot: StorageTaskSnapshot? = {
            stateLock.lock()
            defer { stateLock.unlock() }
            switch _state {
            case .queueing, .running, .progress, .resuming:
                _state = .paused
                return snapshotUnderLock(overrideStatus: .pause)
            default:
                return nil
            }
        }()
        guard let pauseSnapshot else { return }
        gate.markPaused()
        fireObservers(for: .pause, snapshot: pauseSnapshot)
    }

    /// Resumes a paused upload from the confirmed server offset.
    open func resume() {
        let action: (snapshot: StorageTaskSnapshot?, held: Result<CommittedOutcome, Error>?) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard _state == .paused || _state == .pausing else {
                return (nil, nil)
            }
            _state = .running
            let held = heldCommitOutcome
            heldCommitOutcome = nil
            return (snapshotUnderLock(overrideStatus: .resume), held)
        }()
        guard let resumeSnapshot = action.snapshot else { return }
        gate.markResumed()
        fireObservers(for: .resume, snapshot: resumeSnapshot)

        if let held = action.held {
            switch held {
            case .success(let committed):
                completeWithSuccess(committed.metadata)
            case .failure(let err):
                completeWithFailure(err)
            }
        }
    }

    /// Cancels a running or paused upload, aborting staged bytes or rolling back a racing commit.
    open func cancel() {
        let cancelWork: (
            canCancel: Bool,
            uploadId: String?,
            commitTask: Task<CommittedOutcome, Error>?,
            heldOutcome: Result<CommittedOutcome, Error>?
        ) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard !_state.isTerminal else {
                return (false, nil, nil, nil)
            }
            _state = .cancelled
            _error = StorageErrorCode.cancelled as NSError
            let held = heldCommitOutcome
            heldCommitOutcome = nil
            return (true, stagedUploadId, inFlightCommitTask, held)
        }()
        guard cancelWork.canCancel else { return }

        gate.markCancelled()
        let client = reference.storage.bridgeClient
        let actAs = reference.storage.activeAuthLens()

        Task {
            var finalCancelError: Error = StorageErrorCode.cancelled
            var committedToRollback: CommittedOutcome?

            if let heldOutcome = cancelWork.heldOutcome,
               case .success(let committed) = heldOutcome {
                committedToRollback = committed
            } else if let commitTask = cancelWork.commitTask {
                if let committed = try? await commitTask.value {
                    committedToRollback = committed
                }
            }

            if let uploadId = cancelWork.uploadId {
                _ = try? await client.op(
                    method: "storage.abortUpload",
                    params: ["uploadId": .string(uploadId)],
                    actAs: actAs,
                    timeout: 5.0
                )
            }

            if let committed = committedToRollback,
               let rollbackToken = committed.rollbackToken,
               !rollbackToken.isEmpty {
                do {
                    _ = try await client.op(
                        method: "storage.rollbackUpload",
                        params: ["rollbackToken": .string(rollbackToken)],
                        actAs: actAs,
                        timeout: 10.0
                    )
                } catch {
                    finalCancelError = StorageErrorCode.from(error)
                }
            }

            self.settleCancelled(with: finalCancelError)
        }
    }

    // MARK: - State Settlement

    package func emitProgress(completedBytes: Int64, totalBytes: Int64) {
        let progressSnap: StorageTaskSnapshot? = {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard !_state.isTerminal, _state != .paused, _state != .pausing else {
                return nil
            }
            _completedBytes = completedBytes
            _totalBytes = totalBytes
            _state = .progress
            return snapshotUnderLock(overrideStatus: .progress)
        }()
        if let progressSnap {
            fireObservers(for: .progress, snapshot: progressSnap)
        }
    }

    package func deliverOrHoldCommitOutcome(_ outcome: Result<CommittedOutcome, Error>) {
        let heldWhilePaused: Bool = {
            stateLock.lock()
            defer { stateLock.unlock() }
            if _state == .cancelled {
                return true
            }
            if _state == .paused || _state == .pausing {
                heldCommitOutcome = outcome
                return true
            }
            return false
        }()
        guard !heldWhilePaused else { return }

        switch outcome {
        case .success(let committed):
            completeWithSuccess(committed.metadata)
        case .failure(let error):
            completeWithFailure(error)
        }
    }

    package func completeWithSuccess(_ finalMetadata: StorageMetadata) {
        let outcome: (snapshot: StorageTaskSnapshot?, fireCompletion: Bool) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard !_state.isTerminal else {
                return (nil, false)
            }
            _metadata = finalMetadata
            _completedBytes = _totalBytes
            _state = .success
            let shouldFire = !completionFired
            completionFired = true
            return (snapshotUnderLock(overrideStatus: .success), shouldFire)
        }()
        guard let successSnapshot = outcome.snapshot else { return }
        fireObservers(for: .success, snapshot: successSnapshot, clearIfTerminal: true)
        if outcome.fireCompletion, let completion {
            dispatchCallback {
                completion(finalMetadata, nil)
            }
        }
    }

    package func completeWithFailure(_ rawError: Error) {
        let mapped = StorageErrorCode.from(rawError)
        let nsError = mapped as NSError
        let outcome: (snapshot: StorageTaskSnapshot?, fireCompletion: Bool) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard !_state.isTerminal else {
                return (nil, false)
            }
            _error = nsError
            _state = (mapped.code == .cancelled) ? .cancelled : .failed
            let shouldFire = !completionFired
            completionFired = true
            return (snapshotUnderLock(overrideStatus: .failure), shouldFire)
        }()
        guard let failureSnapshot = outcome.snapshot else { return }
        fireObservers(for: .failure, snapshot: failureSnapshot, clearIfTerminal: true)
        if outcome.fireCompletion, let completion {
            dispatchCallback {
                completion(nil, nsError)
            }
        }
    }

    package func settleCancelled(with rawError: Error) {
        let mapped = StorageErrorCode.from(rawError)
        let nsError = mapped as NSError
        let outcome: (snapshot: StorageTaskSnapshot, fireCompletion: Bool) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            _error = nsError
            _state = .cancelled
            let shouldFire = !completionFired
            completionFired = true
            return (snapshotUnderLock(overrideStatus: .failure), shouldFire)
        }()
        fireObservers(for: .failure, snapshot: outcome.snapshot, clearIfTerminal: true)
        if outcome.fireCompletion, let completion {
            dispatchCallback {
                completion(nil, nsError)
            }
        }
    }

    package static func resolveTransferSliceBytes(_ configuredChunkSize: Int64) -> Int {
        let maxCap = Int64(BridgeStorageTransport.maxStoragePartBytes)
        if configuredChunkSize <= 0 || configuredChunkSize == .max {
            return defaultResumableChunkBytes
        }
        let clamped = min(max(Int64(defaultResumableChunkBytes), configuredChunkSize), maxCap)
        return Int(clamped)
    }

    private static func buildInitialSnapshotMetadata(
        reference: StorageReference,
        requested: StorageMetadata?,
        source: UploadSource,
        size: Int64
    ) -> StorageMetadata {
        var dict = requested?.dictionaryRepresentation() ?? [:]
        dict["bucket"] = reference.bucket
        if !reference.fullPath.isEmpty {
            dict["fullPath"] = reference.fullPath
            dict["name"] = reference.fullPath
        }
        dict["size"] = size
        if dict["contentType"] == nil, case .file(let fileURL) = source {
            dict["contentType"] = StorageMimeTypeResolver.inferContentType(for: fileURL)
        }
        return StorageMetadata(dictionary: dict)
    }
}
