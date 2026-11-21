import Foundation

/// Swift `Result` completion overloads mirroring `FirebaseStorage/Sources/Result.swift` (`13.2.0`).
public extension StorageReference {
    func putData(
        _ uploadData: Data,
        metadata: StorageMetadata? = nil,
        completion: @escaping @Sendable (Result<StorageMetadata, Error>) -> Void
    ) {
        putData(uploadData, metadata: metadata, completion: Self.resultAdapter(completion))
    }

    func getData(
        maxSize: Int64,
        completion: @escaping @Sendable (Result<Data, Error>) -> Void
    ) {
        data(maxSize: maxSize, completion: Self.resultAdapter(completion))
    }

    func data(
        maxSize: Int64,
        completion: @escaping @Sendable (Result<Data, Error>) -> Void
    ) {
        data(maxSize: maxSize, completion: Self.resultAdapter(completion))
    }

    func downloadURL(completion: @escaping @Sendable (Result<URL, Error>) -> Void) {
        downloadURL(completion: Self.resultAdapter(completion))
    }

    func getMetadata(completion: @escaping @Sendable (Result<StorageMetadata, Error>) -> Void) {
        getMetadata(completion: Self.resultAdapter(completion))
    }

    func updateMetadata(
        _ metadata: StorageMetadata,
        completion: @escaping @Sendable (Result<StorageMetadata, Error>) -> Void
    ) {
        updateMetadata(metadata, completion: Self.resultAdapter(completion))
    }

    func listAll(completion: @escaping @Sendable (Result<StorageListResult, Error>) -> Void) {
        listAll(completion: Self.resultAdapter(completion))
    }

    func list(
        maxResults: Int64,
        completion: @escaping @Sendable (Result<StorageListResult, Error>) -> Void
    ) {
        list(maxResults: maxResults, completion: Self.resultAdapter(completion))
    }

    func list(
        maxResults: Int64,
        pageToken: String,
        completion: @escaping @Sendable (Result<StorageListResult, Error>) -> Void
    ) {
        list(maxResults: maxResults, pageToken: pageToken, completion: Self.resultAdapter(completion))
    }

    private static func resultAdapter<T: Sendable>(
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
