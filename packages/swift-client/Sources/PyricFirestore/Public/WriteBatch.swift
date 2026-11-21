import Foundation

public final class WriteBatch: @unchecked Sendable {

    private let firestore: Firestore
    private var stagedWrites: [WriteDescriptor] = []
    private var stagedMutations: [OfflineWriteMutation] = []
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
            let encodedSendable = AnySendable.from(encoded)
            stagedWrites.append(
                .set(
                    path: document.path,
                    data: encodedSendable,
                    options: SetOptionsWire(merge: merge)
                )
            )
            stagedMutations.append(
                .set(
                    path: document.path,
                    encodedData: encodedSendable.dictionaryValue ?? [:],
                    merge: merge,
                    mergeFields: nil
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
            let fieldStrings = try WriteDescriptor.validateAndEncodeMergeFields(
                data: data,
                mergeFields: mergeFields
            )
            let encoded = try ValueCodec.encodeWriteData(data)
            let encodedSendable = AnySendable.from(encoded)
            stagedWrites.append(
                .set(
                    path: document.path,
                    data: encodedSendable,
                    options: SetOptionsWire(merge: nil, mergeFields: fieldStrings)
                )
            )
            stagedMutations.append(
                .set(
                    path: document.path,
                    encodedData: encodedSendable.dictionaryValue ?? [:],
                    merge: false,
                    mergeFields: fieldStrings
                )
            )
        } catch {
            preconditionFailure("WriteBatch.setData(mergeFields:) failed: \(error)")
        }
        return self
    }

    @discardableResult
    public func setData<T: Encodable>(
        from value: T,
        forDocument document: DocumentReference,
        merge: Bool = false,
        encoder: Firestore.Encoder = Firestore.Encoder()
    ) throws -> WriteBatch {
        let encodedDict = try encoder.encode(value)
        return setData(encodedDict, forDocument: document, merge: merge)
    }

    @discardableResult
    public func setData<T: Encodable>(
        from value: T,
        forDocument document: DocumentReference,
        mergeFields: [Any],
        encoder: Firestore.Encoder = Firestore.Encoder()
    ) throws -> WriteBatch {
        let encodedDict = try encoder.encode(value)
        return setData(encodedDict, forDocument: document, mergeFields: mergeFields)
    }

    @discardableResult
    public func updateData(
        _ fields: [AnyHashable: Any],
        forDocument document: DocumentReference
    ) -> WriteBatch {
        do {
            try checkCapacity()
            let descriptor = try WriteDescriptor.prepareAtomicUpdate(path: document.path, fields: fields)
            stagedWrites.append(descriptor)
            stagedMutations.append(descriptor.toOfflineMutation())
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
            stagedMutations.append(.delete(path: document.path))
        } catch {
            preconditionFailure("WriteBatch.deleteDocument failed: \(error)")
        }
        return self
    }

    public func commit() async throws {
        try markCommitted()
        let params = PyricBridgeClient.batchCommitParams(writes: stagedWrites)
        try await firestore.send(
            turn: firestore.takeTurn(),
            method: "batchCommit",
            params: params,
            mutations: stagedMutations
        )
    }

    public func commit(completion: (@Sendable (Error?) -> Void)? = nil) {
        // Marked committed at the call, so a second commit fails before it takes a turn.
        do {
            try markCommitted()
        } catch {
            firestore.settings.dispatchCallback { completion?(error) }
            return
        }
        let params = PyricBridgeClient.batchCommitParams(writes: stagedWrites)
        firestore.sendInCallOrder(
            method: "batchCommit",
            params: params,
            mutations: stagedMutations,
            completion: completion
        )
    }

    private func markCommitted() throws {
        guard !isCommitted else {
            throw PyricFirestoreError.invalidArgument("WriteBatch has already been committed.")
        }
        isCommitted = true
    }
}
