import Foundation

public final class TransactionOptions: @unchecked Sendable, NSCopying {
    public var maxAttempts: Int

    public init(maxAttempts: Int = 5) {
        self.maxAttempts = maxAttempts
    }

    public func copy(with zone: NSZone? = nil) -> Any {
        TransactionOptions(maxAttempts: maxAttempts)
    }
}

public final class Transaction: @unchecked Sendable {

    private let firestore: Firestore
    private var hasWritten: Bool = false

    public internal(set) var stagedReads: [TxnReadEntry] = []
    public internal(set) var stagedWrites: [WriteDescriptor] = []

    internal init(firestore: Firestore) {
        self.firestore = firestore
    }

    // ── Transaction Reads (Must precede all writes) ──────────────────────────

    public func getDocument(_ document: DocumentReference) async throws -> DocumentSnapshot {
        guard !hasWritten else {
            throw PyricBridgeError.invalidArgument(
                "Firestore transactions require all reads to be executed before all writes."
            )
        }
        let raw = try await firestore.bridgeClient.getDoc(path: document.path)
        let snapshot = DocumentSnapshot.fromWire(firestore: firestore, path: document.path, wire: raw)

        // Capture read state for optimistic concurrency check
        if snapshot.exists, let rawData = snapshot.rawData {
            let dataJSON = try JSONSerialization.data(withJSONObject: rawData)
            let jsonString = String(data: dataJSON, encoding: .utf8) ?? "{}"
            stagedReads.append(TxnReadEntry(path: document.path, data: SerializedDocData(json: jsonString)))
        } else {
            stagedReads.append(TxnReadEntry(path: document.path, data: nil))
        }

        return snapshot
    }

    private final class BoxedResult: @unchecked Sendable {
        var result: DocumentSnapshot?
        var error: Error?
    }

    public func getDocument(_ document: DocumentReference, error: NSErrorPointer) -> DocumentSnapshot? {
        let box = BoxedResult()
        let semaphore = DispatchSemaphore(value: 0)

        Task { [weak self] in
            guard let self else {
                semaphore.signal()
                return
            }
            do {
                box.result = try await self.getDocument(document)
            } catch let err {
                box.error = err
            }
            semaphore.signal()
        }
        semaphore.wait()

        if let caughtError = box.error {
            error?.pointee = caughtError as NSError
            return nil
        }
        return box.result
    }

    // ── Transaction Writes ───────────────────────────────────────────────────

    @discardableResult
    public func setData(
        _ data: [String: Any],
        forDocument document: DocumentReference
    ) -> Transaction {
        setData(data, forDocument: document, merge: false)
    }

    @discardableResult
    public func setData(
        _ data: [String: Any],
        forDocument document: DocumentReference,
        merge: Bool
    ) -> Transaction {
        hasWritten = true
        do {
            let encoded = try ValueCodec.encodeWriteData(data)
            stagedWrites.append(
                .set(
                    path: document.path,
                    data: AnySendable.from(encoded),
                    options: SetOptionsWire(merge: merge)
                )
            )
        } catch {
            preconditionFailure("Transaction.setData failed: \(error)")
        }
        return self
    }

    @discardableResult
    public func setData(
        _ data: [String: Any],
        forDocument document: DocumentReference,
        mergeFields: [Any]
    ) -> Transaction {
        hasWritten = true
        do {
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
            preconditionFailure("Transaction.setData(mergeFields:) failed: \(error)")
        }
        return self
    }

    @discardableResult
    public func updateData(
        _ fields: [AnyHashable: Any],
        forDocument document: DocumentReference
    ) -> Transaction {
        hasWritten = true
        do {
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
            preconditionFailure("Transaction.updateData failed: \(error)")
        }
        return self
    }

    @discardableResult
    public func deleteDocument(_ document: DocumentReference) -> Transaction {
        hasWritten = true
        stagedWrites.append(.delete(path: document.path))
        return self
    }
}
