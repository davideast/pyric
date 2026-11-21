import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import PyricFirestore

/// Controllable and observable download task supporting in-memory `Data` (`getData` / `data`)
/// and local file `URL` (`write(toFile:)`) targets with progress, `pause()`, `resume()`, and `cancel()`.
open class StorageDownloadTask: StorageObservableTask, StorageTaskManagement, @unchecked Sendable {
    package static let defaultDownloadSliceBytes: Int = 256 * 1024

    package enum DownloadTarget: Sendable {
        case memory(maxSize: Int64, completion: (@Sendable (Data?, Error?) -> Void)?)
        case file(fileURL: URL, completion: (@Sendable (URL?, Error?) -> Void)?)
    }

    package let target: DownloadTarget
    package let gate = StorageTransferGate()
    package var hasEnqueued = false
    package var completionFired = false

    package init(
        reference: StorageReference,
        target: DownloadTarget
    ) {
        self.target = target
        super.init(
            reference: reference,
            callbackQueue: reference.storage.callbackQueue,
            initialMetadata: nil,
            totalBytes: 0
        )
    }

    /// Starts execution of the download task if not already enqueued.
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
        let timeout = reference.storage.maxDownloadRetryTime

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
            await self.runDownload(
                client: client,
                turn: turn,
                actAs: actAs,
                timeout: timeout
            )
        }
    }

    /// Pauses an active download between or during slice transfers.
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

    /// Resumes a paused download from the current confirmed byte offset.
    open func resume() {
        let resumeSnapshot: StorageTaskSnapshot? = {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard _state == .paused || _state == .pausing else {
                return nil
            }
            _state = .running
            return snapshotUnderLock(overrideStatus: .resume)
        }()
        guard let resumeSnapshot else { return }
        gate.markResumed()
        fireObservers(for: .resume, snapshot: resumeSnapshot)
    }

    /// Cancels a running or paused download, cleaning up any staged partial file.
    open func cancel() {
        let outcome: (canCancel: Bool, snapshot: StorageTaskSnapshot?, fireCompletion: Bool) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard !_state.isTerminal else {
                return (false, nil, false)
            }
            _state = .cancelled
            _error = StorageErrorCode.cancelled as NSError
            let shouldFire = !completionFired
            completionFired = true
            return (true, snapshotUnderLock(overrideStatus: .failure), shouldFire)
        }()
        guard outcome.canCancel, let failureSnapshot = outcome.snapshot else { return }
        gate.markCancelled()
        fireObservers(for: .failure, snapshot: failureSnapshot, clearIfTerminal: true)
        if outcome.fireCompletion {
            invokeFailureCompletion(StorageErrorCode.cancelled as NSError)
        }
    }

    // MARK: - Terminal Settlement

    package func finalizeDownloadedBytes(_ bytes: Data) throws {
        switch target {
        case .memory(_, _):
            completeWithSuccessData(bytes)
        case .file(let destURL, _):
            let parentDir = destURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: parentDir, withIntermediateDirectories: true)
            let tempURL = parentDir.appendingPathComponent(
                ".\(destURL.lastPathComponent).pyric-dl-\(UUID().uuidString).part"
            )
            defer {
                try? FileManager.default.removeItem(at: tempURL)
            }
            try bytes.write(to: tempURL, options: .atomic)
            if FileManager.default.fileExists(atPath: destURL.path) {
                try FileManager.default.removeItem(at: destURL)
            }
            try FileManager.default.moveItem(at: tempURL, to: destURL)
            completeWithSuccessFile(destURL)
        }
    }

    package func emitProgress(completedBytes: Int64, totalBytes: Int64) {
        let snap: StorageTaskSnapshot? = {
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
        if let snap {
            fireObservers(for: .progress, snapshot: snap)
        }
    }

    package func completeWithSuccessData(_ bytes: Data) {
        let outcome: (snapshot: StorageTaskSnapshot?, fireCompletion: Bool) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard !_state.isTerminal else { return (nil, false) }
            _completedBytes = Int64(bytes.count)
            _totalBytes = Int64(bytes.count)
            _state = .success
            let shouldFire = !completionFired
            completionFired = true
            return (snapshotUnderLock(overrideStatus: .success), shouldFire)
        }()
        guard let successSnap = outcome.snapshot else { return }
        fireObservers(for: .success, snapshot: successSnap, clearIfTerminal: true)
        if outcome.fireCompletion, case .memory(_, let completion) = target, let completion {
            dispatchCallback {
                completion(bytes, nil)
            }
        }
    }

    package func completeWithSuccessFile(_ url: URL) {
        let outcome: (snapshot: StorageTaskSnapshot?, fireCompletion: Bool) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard !_state.isTerminal else { return (nil, false) }
            _completedBytes = _totalBytes
            _state = .success
            let shouldFire = !completionFired
            completionFired = true
            return (snapshotUnderLock(overrideStatus: .success), shouldFire)
        }()
        guard let successSnap = outcome.snapshot else { return }
        fireObservers(for: .success, snapshot: successSnap, clearIfTerminal: true)
        if outcome.fireCompletion, case .file(_, let completion) = target, let completion {
            dispatchCallback {
                completion(url, nil)
            }
        }
    }

    package func completeWithFailure(_ rawError: Error) {
        let mapped = StorageErrorCode.from(rawError)
        let nsError = mapped as NSError
        let outcome: (snapshot: StorageTaskSnapshot?, fireCompletion: Bool) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            guard !_state.isTerminal else { return (nil, false) }
            _error = nsError
            _state = (mapped.code == .cancelled) ? .cancelled : .failed
            let shouldFire = !completionFired
            completionFired = true
            return (snapshotUnderLock(overrideStatus: .failure), shouldFire)
        }()
        guard let failureSnap = outcome.snapshot else { return }
        fireObservers(for: .failure, snapshot: failureSnap, clearIfTerminal: true)
        if outcome.fireCompletion {
            invokeFailureCompletion(nsError)
        }
    }

    package func invokeFailureCompletion(_ nsError: NSError) {
        switch target {
        case .memory(_, let completion):
            if let completion {
                dispatchCallback { completion(nil, nsError) }
            }
        case .file(_, let completion):
            if let completion {
                dispatchCallback { completion(nil, nsError) }
            }
        }
    }
}
