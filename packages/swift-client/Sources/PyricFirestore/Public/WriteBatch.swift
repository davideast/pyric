import Foundation

public final class WriteBatch: @unchecked Sendable {

    private let firestore: Firestore
    private var stagedWrites: [WriteDescriptor] = []
    private var isCommitted: Bool = false

    internal init(firestore: Firestore) {
        self.firestore = firestore
    }

    private func checkCapacity() throws {
        guard !isCommitted else {
            throw PyricFirestoreError.invalidArgument("A WriteBatch cannot be modified after commit.")
        }
        guard stagedWrites.count < 500 else {
            throw PyricBridgeError.invalidArgument(
                "Maximum allowable write batch mutations exceeded (limit: 500 writes)."
            )
        }
    }

    @discardableResult
    public func setData(
        _ data: [String: Any],
        forDocument document: DocumentReference
    ) -> WriteBatch {
        setData(data, forDocument: document, merge: false)
    }

    @discardableResult
    public func setData(
        _ data: [String: Any],
        forDocument document: DocumentReference,
        merge: Bool
    ) -> WriteBatch {
        do {
            try checkCapacity()
            let encoded = try ValueCodec.encodeWriteData(data)
            stagedWrites.append(
                .set(
                    path: document.path,
                    data: AnySendable.from(encoded),
                    options: SetOptionsWire(merge: merge)
                )
            )
        } catch {
            preconditionFailure("WriteBatch.setData failed: \(error)")
        }
        return self
    }

    @discardableResult
    public func setData(
        _ data: [String: Any],
        forDocument document: DocumentReference,
        mergeFields: [Any]
    ) -> WriteBatch {
        do {
            try checkCapacity()
            let fieldStrings = try mergeFields.map { item -> String in
                if let s = item as? String { return s }
                if let fp = item as? FieldPath { return fp.stringRepresentation }
                throw PyricFirestoreError.invalidArgument("mergeFields elements must be String or FieldPath")
            }
            for field in fieldStrings {
                let rootKey = field.components(separatedBy: ".").first ?? field
                guard data.keys.contains(rootKey) else {
                    throw PyricFirestoreError.invalidArgument(
                        "Field '\(field)' specified in mergeFields was not provided in data."
                    )
                }
            }
            let encoded = try ValueCodec.encodeWriteData(data)
            stagedWrites.append(
                .set(
                    path: document.path,
                    data: AnySendable.from(encoded),
                    options: SetOptionsWire(merge: nil, mergeFields: fieldStrings)
                )
            )
        } catch {
            preconditionFailure("WriteBatch.setData(mergeFields:) failed: \(error)")
        }
        return self
    }

    @discardableResult
    public func updateData(
        _ fields: [AnyHashable: Any],
        forDocument document: DocumentReference
    ) -> WriteBatch {
        do {
            try checkCapacity()
            var stringDict: [String: Any] = [:]
            for (key, val) in fields {
                if let str = key as? String {
                    stringDict[str] = val
                } else if let fp = key as? FieldPath {
                    stringDict[fp.stringRepresentation] = val
                } else {
                    throw PyricFirestoreError.invalidArgument("updateData keys must be String or FieldPath")
                }
            }
            let encoded = try ValueCodec.encodeWriteData(stringDict)
            stagedWrites.append(
                .update(
                    path: document.path,
                    data: AnySendable.from(encoded)
                )
            )
        } catch {
            preconditionFailure("WriteBatch.updateData failed: \(error)")
        }
        return self
    }

    @discardableResult
    public func deleteDocument(_ document: DocumentReference) -> WriteBatch {
        do {
            try checkCapacity()
            stagedWrites.append(.delete(path: document.path))
        } catch {
            preconditionFailure("WriteBatch.deleteDocument failed: \(error)")
        }
        return self
    }

    public func commit() async throws {
        guard !isCommitted else {
            throw PyricFirestoreError.invalidArgument("WriteBatch has already been committed.")
        }
        isCommitted = true
        try await firestore.bridgeClient.batchCommit(writes: stagedWrites)
    }

    public func commit(completion: (@Sendable (Error?) -> Void)? = nil) {
        Task {
            do {
                try await commit()
                firestore.settings.dispatchQueue.async { completion?(nil) }
            } catch {
                firestore.settings.dispatchQueue.async { completion?(error) }
            }
        }
    }
}
