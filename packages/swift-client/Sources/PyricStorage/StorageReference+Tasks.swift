import Foundation

/// Lock-guarded cancellation bridge propagating Swift structured concurrency `Task.cancel()`
/// into `StorageTaskManagement.cancel()`, matching `FirebaseStorage 13.2.0` (`AsyncAwait.swift`).
package final class StorageTaskCanceller: @unchecked Sendable {
    private let lock = NSLock()
    private var isCancelled = false
    private var task: (any StorageTaskManagement)?

    package init() {}

    package func install(_ storageTask: any StorageTaskManagement) {
        let cancelImmediately: Bool = {
            lock.lock()
            defer { lock.unlock() }
            self.task = storageTask
            return isCancelled
        }()
        if cancelImmediately {
            storageTask.cancel()
        }
    }

    package func cancel() {
        let currentTask: (any StorageTaskManagement)? = {
            lock.lock()
            defer { lock.unlock() }
            guard !isCancelled else { return nil }
            isCancelled = true
            return task
        }()
        currentTask?.cancel()
    }
}

package func withCancellableStorageTask<T: Sendable>(
    _ start: (CheckedContinuation<T, Error>) -> any StorageTaskManagement
) async throws -> T {
    let canceller = StorageTaskCanceller()
    return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
            let storageTask = start(continuation)
            canceller.install(storageTask)
        }
    } onCancel: {
        canceller.cancel()
    }
}

// MARK: - StorageReference File I/O & Task Extensions

extension StorageReference {
    /// Uploads a local file at `fileURL` to this `StorageReference`, returning an observable `StorageUploadTask`.
    @discardableResult
    public func putFile(
        from fileURL: URL,
        metadata: StorageMetadata? = nil,
        completion: (@Sendable (StorageMetadata?, Error?) -> Void)? = nil
    ) -> StorageUploadTask {
        let uploadTask = StorageUploadTask(
            reference: self,
            source: .file(fileURL),
            metadata: metadata,
            completion: completion
        )
        uploadTask.enqueue()
        return uploadTask
    }

    /// `Result` completion overload of `putFile(from:metadata:completion:)`.
    @discardableResult
    public func putFile(
        from fileURL: URL,
        metadata: StorageMetadata? = nil,
        completion: @escaping @Sendable (Result<StorageMetadata, Error>) -> Void
    ) -> StorageUploadTask {
        putFile(from: fileURL, metadata: metadata, completion: Self.taskResultAdapter(completion))
    }

    /// Async upload of a local file at `url` with optional `Progress` snapshots and cancellation propagation.
    public func putFileAsync(
        from url: URL,
        metadata: StorageMetadata? = nil,
        onProgress: (@Sendable (Progress?) -> Void)? = nil
    ) async throws -> StorageMetadata {
        try await withCancellableStorageTask { continuation in
            let uploadTask = StorageUploadTask(
                reference: self,
                source: .file(url),
                metadata: metadata
            ) { stored, error in
                if let stored {
                    continuation.resume(returning: stored)
                } else if let error {
                    continuation.resume(throwing: StorageErrorCode.from(error))
                } else {
                    continuation.resume(throwing: StorageErrorCode.internalError)
                }
            }
            if let onProgress {
                uploadTask.observe(.progress) { snapshot in
                    onProgress(snapshot.progress)
                }
            }
            uploadTask.enqueue()
            return uploadTask
        }
    }

    /// Downloads the object at this `StorageReference` to a local file `URL`, returning a `StorageDownloadTask`.
    @discardableResult
    public func write(toFile fileURL: URL) -> StorageDownloadTask {
        write(toFile: fileURL, completion: nil)
    }

    /// Downloads the object at this `StorageReference` to a local file `URL`, invoking `completion` when finished.
    @discardableResult
    public func write(
        toFile fileURL: URL,
        completion: (@Sendable (URL?, Error?) -> Void)?
    ) -> StorageDownloadTask {
        let downloadTask = StorageDownloadTask(
            reference: self,
            target: .file(fileURL: fileURL, completion: completion)
        )
        downloadTask.enqueue()
        return downloadTask
    }

    /// `Result` completion overload of `write(toFile:completion:)`.
    @discardableResult
    public func write(
        toFile fileURL: URL,
        completion: @escaping @Sendable (Result<URL, Error>) -> Void
    ) -> StorageDownloadTask {
        write(toFile: fileURL, completion: Self.taskResultAdapter(completion))
    }

    /// Async download of the object at this `StorageReference` to `fileURL` with optional `Progress` snapshots.
    public func writeAsync(
        toFile fileURL: URL,
        onProgress: (@Sendable (Progress?) -> Void)? = nil
    ) async throws -> URL {
        try await withCancellableStorageTask { continuation in
            let downloadTask = StorageDownloadTask(
                reference: self,
                target: .file(fileURL: fileURL) { savedURL, error in
                    if let savedURL {
                        continuation.resume(returning: savedURL)
                    } else if let error {
                        continuation.resume(throwing: StorageErrorCode.from(error))
                    } else {
                        continuation.resume(throwing: StorageErrorCode.internalError)
                    }
                }
            )
            if let onProgress {
                downloadTask.observe(.progress) { snapshot in
                    onProgress(snapshot.progress)
                }
            }
            downloadTask.enqueue()
            return downloadTask
        }
    }

    package static func taskResultAdapter<T: Sendable>(
        _ completion: @escaping @Sendable (Result<T, Error>) -> Void
    ) -> @Sendable (T?, Error?) -> Void {
        { value, error in
            if let value {
                completion(.success(value))
            } else if let error {
                completion(.failure(error))
            } else {
                completion(.failure(StorageErrorCode.internalError))
            }
        }
    }
}
