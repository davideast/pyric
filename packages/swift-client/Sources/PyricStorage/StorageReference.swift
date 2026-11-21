import Foundation
import PyricFirestore

/// Represents a reference to a Google Cloud Storage object or prefix, mirroring `StorageReference` (`13.2.0`).
public final class StorageReference: NSObject, Sendable {
    /// The `Storage` service instance that created this reference.
    public let storage: Storage

    /// The Cloud Storage bucket name associated with this reference.
    public let bucket: String

    /// The normalized object path relative to the bucket root (`""` for root).
    public let fullPath: String

    package let isNamedBucket: Bool

    /// The final path component of `fullPath` (`""` for root).
    public var name: String {
        ParsedStorageLocation.lastComponent(of: fullPath)
    }

    package init(
        storage: Storage,
        bucket: String,
        fullPath: String,
        isNamedBucket: Bool
    ) {
        self.storage = storage
        self.bucket = bucket
        self.fullPath = ParsedStorageLocation.normalizePath(fullPath)
        self.isNamedBucket = isNamedBucket
        super.init()
    }

    // MARK: - Hierarchy Navigation

    /// Returns a new `StorageReference` pointing to the root of this bucket.
    public func root() -> StorageReference {
        StorageReference(storage: storage, bucket: bucket, fullPath: "", isNamedBucket: isNamedBucket)
    }

    /// Returns a new `StorageReference` pointing to the parent path, or `nil` if at root.
    public func parent() -> StorageReference? {
        guard let parentPath = ParsedStorageLocation.parentPath(of: fullPath) else {
            return nil
        }
        return StorageReference(storage: storage, bucket: bucket, fullPath: parentPath, isNamedBucket: isNamedBucket)
    }

    /// Returns a new `StorageReference` pointing to a normalized child path relative to this reference.
    public func child(_ path: String) -> StorageReference {
        let joined = ParsedStorageLocation.childPath(parent: fullPath, child: path)
        return StorageReference(storage: storage, bucket: bucket, fullPath: joined, isNamedBucket: isNamedBucket)
    }

    package var bucketWireParams: [String: AnySendable] {
        var wire: [String: AnySendable] = [:]
        if isNamedBucket && !bucket.isEmpty {
            wire["bucket"] = .string(bucket)
        }
        if let defaultBucket = storage.configuredDefaultBucket, !defaultBucket.isEmpty {
            wire["defaultBucket"] = .string(defaultBucket)
        }
        return wire
    }

    // MARK: - Upload Data

    /// Uploads in-memory `Data` to this `StorageReference`, returning an observable `StorageUploadTask`.
    @discardableResult
    public func putData(
        _ uploadData: Data,
        metadata: StorageMetadata? = nil,
        completion: (@Sendable (StorageMetadata?, Error?) -> Void)? = nil
    ) -> StorageUploadTask {
        let uploadTask = StorageUploadTask(
            reference: self,
            source: .data(uploadData),
            metadata: metadata,
            completion: completion
        )
        uploadTask.enqueue()
        return uploadTask
    }

    /// Async upload of in-memory `Data` to this `StorageReference` with optional `Progress` snapshots.
    public func putDataAsync(
        _ uploadData: Data,
        metadata: StorageMetadata? = nil,
        onProgress: (@Sendable (Progress?) -> Void)? = nil
    ) async throws -> StorageMetadata {
        try await withCancellableStorageTask { continuation in
            let uploadTask = StorageUploadTask(
                reference: self,
                source: .data(uploadData),
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

    // MARK: - Download Data

    /// Downloads the object at this `StorageReference` in memory up to `maxSize` bytes (`FirebaseStorage` spelling).
    @discardableResult
    public func getData(
        maxSize: Int64,
        completion: @escaping @Sendable (Data?, Error?) -> Void
    ) -> StorageDownloadTask {
        data(maxSize: maxSize, completion: completion)
    }

    /// Downloads the object at this `StorageReference` in memory up to `maxSize` bytes.
    @discardableResult
    public func data(
        maxSize: Int64,
        completion: @escaping @Sendable (Data?, Error?) -> Void
    ) -> StorageDownloadTask {
        let downloadTask = StorageDownloadTask(
            reference: self,
            target: .memory(maxSize: maxSize, completion: completion)
        )
        downloadTask.enqueue()
        return downloadTask
    }

    /// Async download of the object at this `StorageReference` up to `maxSize` bytes.
    public func data(maxSize: Int64) async throws -> Data {
        try await withCancellableStorageTask { continuation in
            let downloadTask = StorageDownloadTask(
                reference: self,
                target: .memory(maxSize: maxSize) { bytes, error in
                    if let bytes {
                        continuation.resume(returning: bytes)
                    } else if let error {
                        continuation.resume(throwing: StorageErrorCode.from(error))
                    } else {
                        continuation.resume(throwing: StorageErrorCode.internalError)
                    }
                }
            )
            downloadTask.enqueue()
            return downloadTask
        }
    }

    // MARK: - Download URL

    /// Retrieves a persistent tokenized download `URL` for this object.
    public func downloadURL(completion: @escaping @Sendable (URL?, Error?) -> Void) {
        storage.markUsed()
        let client = storage.bridgeClient
        let turn = client.takeTurn()
        let actAs = storage.activeAuthLens()
        let timeout = storage.maxOperationRetryTime
        let storage = self.storage
        Task {
            do {
                let url = try await BridgeStorageTransport.getDownloadURL(
                    reference: self,
                    client: client,
                    turn: turn,
                    actAs: actAs,
                    timeout: timeout
                )
                storage.dispatchCallback { completion(url, nil) }
            } catch {
                let mapped = StorageErrorCode.from(error) as NSError
                storage.dispatchCallback { completion(nil, mapped) }
            }
        }
    }

    /// Async retrieval of a persistent tokenized download `URL` for this object.
    public func downloadURL() async throws -> URL {
        storage.markUsed()
        let client = storage.bridgeClient
        let turn = client.takeTurn()
        let actAs = storage.activeAuthLens()
        do {
            return try await BridgeStorageTransport.getDownloadURL(
                reference: self,
                client: client,
                turn: turn,
                actAs: actAs,
                timeout: storage.maxOperationRetryTime
            )
        } catch {
            throw StorageErrorCode.from(error)
        }
    }

    // MARK: - Metadata Operations

    /// Retrieves `StorageMetadata` for the object at this `StorageReference`.
    public func getMetadata(completion: @escaping @Sendable (StorageMetadata?, Error?) -> Void) {
        storage.markUsed()
        let client = storage.bridgeClient
        let turn = client.takeTurn()
        let actAs = storage.activeAuthLens()
        let timeout = storage.maxOperationRetryTime
        let storage = self.storage
        Task {
            do {
                let meta = try await BridgeStorageTransport.getMetadata(
                    reference: self,
                    client: client,
                    turn: turn,
                    actAs: actAs,
                    timeout: timeout
                )
                storage.dispatchCallback { completion(meta, nil) }
            } catch {
                let mapped = StorageErrorCode.from(error) as NSError
                storage.dispatchCallback { completion(nil, mapped) }
            }
        }
    }

    /// Async retrieval of `StorageMetadata` (`FirebaseStorage 13.2.0` spelling).
    public func getMetadata() async throws -> StorageMetadata {
        try await metadata()
    }

    /// Async retrieval of `StorageMetadata` (`metadata()` alias).
    public func metadata() async throws -> StorageMetadata {
        storage.markUsed()
        let client = storage.bridgeClient
        let turn = client.takeTurn()
        let actAs = storage.activeAuthLens()
        do {
            return try await BridgeStorageTransport.getMetadata(
                reference: self,
                client: client,
                turn: turn,
                actAs: actAs,
                timeout: storage.maxOperationRetryTime
            )
        } catch {
            throw StorageErrorCode.from(error)
        }
    }

    /// Updates settable `StorageMetadata` fields on the object at this `StorageReference`.
    public func updateMetadata(
        _ metadata: StorageMetadata,
        completion: (@Sendable (StorageMetadata?, Error?) -> Void)? = nil
    ) {
        storage.markUsed()
        let client = storage.bridgeClient
        let turn = client.takeTurn()
        let actAs = storage.activeAuthLens()
        let timeout = storage.maxOperationRetryTime
        let storage = self.storage
        Task {
            do {
                let updated = try await BridgeStorageTransport.updateMetadata(
                    reference: self,
                    client: client,
                    turn: turn,
                    actAs: actAs,
                    metadata: metadata,
                    timeout: timeout
                )
                if let completion {
                    storage.dispatchCallback { completion(updated, nil) }
                }
            } catch {
                if let completion {
                    let mapped = StorageErrorCode.from(error) as NSError
                    storage.dispatchCallback { completion(nil, mapped) }
                }
            }
        }
    }

    /// Async update of settable `StorageMetadata` fields on the object at this `StorageReference`.
    public func updateMetadata(_ metadata: StorageMetadata) async throws -> StorageMetadata {
        storage.markUsed()
        let client = storage.bridgeClient
        let turn = client.takeTurn()
        let actAs = storage.activeAuthLens()
        do {
            return try await BridgeStorageTransport.updateMetadata(
                reference: self,
                client: client,
                turn: turn,
                actAs: actAs,
                metadata: metadata,
                timeout: storage.maxOperationRetryTime
            )
        } catch {
            throw StorageErrorCode.from(error)
        }
    }

    // MARK: - Delete

    /// Deletes the object at this `StorageReference`.
    public func delete(completion: (@Sendable (Error?) -> Void)? = nil) {
        storage.markUsed()
        let client = storage.bridgeClient
        let turn = client.takeTurn()
        let actAs = storage.activeAuthLens()
        let timeout = storage.maxOperationRetryTime
        let storage = self.storage
        Task {
            do {
                try await BridgeStorageTransport.deleteObject(
                    reference: self,
                    client: client,
                    turn: turn,
                    actAs: actAs,
                    timeout: timeout
                )
                if let completion {
                    storage.dispatchCallback { completion(nil) }
                }
            } catch {
                if let completion {
                    let mapped = StorageErrorCode.from(error) as NSError
                    storage.dispatchCallback { completion(mapped) }
                }
            }
        }
    }

    /// Async deletion of the object at this `StorageReference`.
    public func delete() async throws {
        storage.markUsed()
        let client = storage.bridgeClient
        let turn = client.takeTurn()
        let actAs = storage.activeAuthLens()
        do {
            try await BridgeStorageTransport.deleteObject(
                reference: self,
                client: client,
                turn: turn,
                actAs: actAs,
                timeout: storage.maxOperationRetryTime
            )
        } catch {
            throw StorageErrorCode.from(error)
        }
    }

    // MARK: - List & Pagination

    /// Lists all prefixes and items directly under this `StorageReference`.
    public func listAll(completion: @escaping @Sendable (StorageListResult?, Error?) -> Void) {
        listInternal(maxResults: nil, pageToken: nil, completion: completion)
    }

    /// Async listing of all prefixes and items directly under this `StorageReference`.
    public func listAll() async throws -> StorageListResult {
        try await performListAsync(maxResults: nil, pageToken: nil)
    }

    /// Lists up to `maxResults` (`1...1000`) prefixes and items under this `StorageReference`.
    public func list(
        maxResults: Int64,
        completion: @escaping @Sendable (StorageListResult?, Error?) -> Void
    ) {
        listInternal(maxResults: maxResults, pageToken: nil, completion: completion)
    }

    /// Resumes a paginated `list(maxResults:)` call starting from `pageToken`.
    public func list(
        maxResults: Int64,
        pageToken: String,
        completion: @escaping @Sendable (StorageListResult?, Error?) -> Void
    ) {
        listInternal(maxResults: maxResults, pageToken: pageToken, completion: completion)
    }

    /// Async paginated listing of up to `maxResults` (`1...1000`) entries, optionally resuming from `pageToken`.
    public func list(maxResults: Int64, pageToken: String? = nil) async throws -> StorageListResult {
        try await performListAsync(maxResults: maxResults, pageToken: pageToken)
    }

    // MARK: - NSObject Overrides

    override public func copy() -> Any {
        StorageReference(storage: storage, bucket: bucket, fullPath: fullPath, isNamedBucket: isNamedBucket)
    }

    override public func isEqual(_ object: Any?) -> Bool {
        guard let other = object as? StorageReference else { return false }
        return storage == other.storage && bucket == other.bucket && fullPath == other.fullPath
    }

    override public var hash: Int {
        var hasher = Hasher()
        hasher.combine(storage)
        hasher.combine(bucket)
        hasher.combine(fullPath)
        return hasher.finalize()
    }

    override public var description: String {
        "gs://\(bucket)/\(fullPath)"
    }

    private func performListAsync(maxResults: Int64?, pageToken: String?) async throws -> StorageListResult {
        storage.markUsed()
        let client = storage.bridgeClient
        let turn = client.takeTurn()
        let actAs = storage.activeAuthLens()
        do {
            return try await BridgeStorageTransport.list(
                reference: self,
                client: client,
                turn: turn,
                actAs: actAs,
                maxResults: maxResults,
                pageToken: pageToken,
                timeout: storage.maxOperationRetryTime
            )
        } catch {
            throw StorageErrorCode.from(error)
        }
    }

    private func listInternal(
        maxResults: Int64?,
        pageToken: String?,
        completion: @escaping @Sendable (StorageListResult?, Error?) -> Void
    ) {
        storage.markUsed()
        let client = storage.bridgeClient
        let turn = client.takeTurn()
        let actAs = storage.activeAuthLens()
        let timeout = storage.maxOperationRetryTime
        let storage = self.storage
        Task {
            do {
                let listed = try await BridgeStorageTransport.list(
                    reference: self,
                    client: client,
                    turn: turn,
                    actAs: actAs,
                    maxResults: maxResults,
                    pageToken: pageToken,
                    timeout: timeout
                )
                storage.dispatchCallback { completion(listed, nil) }
            } catch {
                let mapped = StorageErrorCode.from(error) as NSError
                storage.dispatchCallback { completion(nil, mapped) }
            }
        }
    }
}
