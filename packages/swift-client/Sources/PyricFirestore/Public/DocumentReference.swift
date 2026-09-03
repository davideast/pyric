import Foundation

public final class DocumentReference: PathReferenceable, Equatable, Hashable, @unchecked Sendable {

    public let firestore: Firestore
    public let path: String

    public var documentID: String {
        guard let last = path.components(separatedBy: "/").last else { return "" }
        return last
    }

    public var parent: CollectionReference {
        let segments = path.components(separatedBy: "/")
        let parentPath = segments.dropLast().joined(separator: "/")
        return CollectionReference(firestore: firestore, path: parentPath)
    }

    public init(firestore: Firestore, path: String) {
        self.firestore = firestore
        self.path = path
    }

    // ── Subcollections ───────────────────────────────────────────────────────

    public func collection(_ collectionPath: String) -> CollectionReference {
        let clean = collectionPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let segments = clean.components(separatedBy: "/")
        precondition(
            !clean.isEmpty && segments.count % 2 == 1,
            "Invalid subcollection path '\(collectionPath)'. Must have an odd number of segments."
        )
        return CollectionReference(firestore: firestore, path: "\(path)/\(clean)")
    }

    // ── Retrieving Data ──────────────────────────────────────────────────────

    public func getDocument(source: FirestoreSource = .default) async throws -> DocumentSnapshot {
        let raw = try await firestore.bridgeClient.getDoc(path: path)
        return DocumentSnapshot.fromWire(firestore: firestore, path: path, wire: raw)
    }

    public func getDocument(completion: @escaping @Sendable (DocumentSnapshot?, Error?) -> Void) {
        getDocument(source: .default, completion: completion)
    }

    public func getDocument(
        source: FirestoreSource,
        completion: @escaping @Sendable (DocumentSnapshot?, Error?) -> Void
    ) {
        let box = CallbackBox(completion)
        let docPath = self.path
        let db = self.firestore
        Task {
            do {
                let raw = try await db.bridgeClient.getDoc(path: docPath)
                let snapshot = DocumentSnapshot.fromWire(firestore: db, path: docPath, wire: raw)
                db.settings.dispatchQueue.async {
                    box.callback(snapshot, nil)
                }
            } catch {
                db.settings.dispatchQueue.async {
                    box.callback(nil, error)
                }
            }
        }
    }

    // ── Writing Data ─────────────────────────────────────────────────────────

    public func setData(_ data: [String: Any], merge: Bool = false) async throws {
        let options = SetOptionsWire(merge: merge)
        let encoded = try ValueCodec.encodeWriteData(data)
        let sendableData = AnySendable.from(encoded)
        try await firestore.bridgeClient.setDoc(
            path: path,
            data: sendableData,
            options: options
        )
    }

    public func setData(_ data: [String: Any], mergeFields: [Any]) async throws {
        let fieldStrings = try mergeFields.map { item -> String in
            if let str = item as? String { return str }
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
        let options = SetOptionsWire(merge: nil, mergeFields: fieldStrings)
        let encoded = try ValueCodec.encodeWriteData(data)
        let sendableData = AnySendable.from(encoded)
        try await firestore.bridgeClient.setDoc(
            path: path,
            data: sendableData,
            options: options
        )
    }

    public func setData(_ data: [String: Any], completion: (@Sendable (Error?) -> Void)? = nil) {
        setData(data, merge: false, completion: completion)
    }

    public func setData(_ data: [String: Any], merge: Bool, completion: (@Sendable (Error?) -> Void)? = nil) {
        do {
            let options = SetOptionsWire(merge: merge)
            let encoded = try ValueCodec.encodeWriteData(data)
            let sendableData = AnySendable.from(encoded)
            let docPath = self.path
            let db = self.firestore
            let box = ErrorCallbackBox(completion)
            Task {
                do {
                    try await db.bridgeClient.setDoc(path: docPath, data: sendableData, options: options)
                    db.settings.dispatchQueue.async { box.callback?(nil) }
                } catch {
                    db.settings.dispatchQueue.async { box.callback?(error) }
                }
            }
        } catch {
            firestore.settings.dispatchQueue.async { completion?(error) }
        }
    }

    public func setData(_ data: [String: Any], mergeFields: [Any], completion: (@Sendable (Error?) -> Void)? = nil) {
        do {
            let fieldStrings = try mergeFields.map { item -> String in
                if let str = item as? String { return str }
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
            let options = SetOptionsWire(merge: nil, mergeFields: fieldStrings)
            let encoded = try ValueCodec.encodeWriteData(data)
            let sendableData = AnySendable.from(encoded)
            let docPath = self.path
            let db = self.firestore
            let box = ErrorCallbackBox(completion)
            Task {
                do {
                    try await db.bridgeClient.setDoc(path: docPath, data: sendableData, options: options)
                    db.settings.dispatchQueue.async { box.callback?(nil) }
                } catch {
                    db.settings.dispatchQueue.async { box.callback?(error) }
                }
            }
        } catch {
            firestore.settings.dispatchQueue.async { completion?(error) }
        }
    }

    public func updateData(_ fields: [AnyHashable: Any]) async throws {
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
        let sendableData = AnySendable.from(encoded)
        try await firestore.bridgeClient.updateDoc(path: path, data: sendableData)
    }

    public func updateData(_ fields: [AnyHashable: Any], completion: (@Sendable (Error?) -> Void)? = nil) {
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
            let sendableData = AnySendable.from(encoded)
            let docPath = self.path
            let db = self.firestore
            let box = ErrorCallbackBox(completion)
            Task {
                do {
                    try await db.bridgeClient.updateDoc(path: docPath, data: sendableData)
                    db.settings.dispatchQueue.async { box.callback?(nil) }
                } catch {
                    db.settings.dispatchQueue.async { box.callback?(error) }
                }
            }
        } catch {
            firestore.settings.dispatchQueue.async { completion?(error) }
        }
    }

    public func delete() async throws {
        try await firestore.bridgeClient.deleteDoc(path: path)
    }

    public func delete(completion: (@Sendable (Error?) -> Void)? = nil) {
        let docPath = self.path
        let db = self.firestore
        let box = ErrorCallbackBox(completion)
        Task {
            do {
                try await db.bridgeClient.deleteDoc(path: docPath)
                db.settings.dispatchQueue.async { box.callback?(nil) }
            } catch {
                db.settings.dispatchQueue.async { box.callback?(error) }
            }
        }
    }

    // ── Real-Time Snapshot Listeners ─────────────────────────────────────────

    public func addSnapshotListener(
        _ listener: @escaping @Sendable (DocumentSnapshot?, Error?) -> Void
    ) -> ListenerRegistration {
        addSnapshotListener(includeMetadataChanges: false, listener: listener)
    }

    public func addSnapshotListener(
        includeMetadataChanges: Bool,
        listener: @escaping @Sendable (DocumentSnapshot?, Error?) -> Void
    ) -> ListenerRegistration {
        let stream = firestore.bridgeClient.subscribe(
            target: TargetDescriptor.doc(path: path),
            includeMetadataChanges: includeMetadataChanges
        )
        let box = CallbackBox(listener)
        let docPath = self.path
        let db = self.firestore

        let task = Task {
            do {
                for try await event in stream {
                    let snapshot = DocumentSnapshot.fromWire(firestore: db, path: docPath, wire: event)
                    db.settings.dispatchCallback {
                        box.callback(snapshot, nil)
                    }
                }
            } catch {
                db.settings.dispatchCallback {
                    box.callback(nil, error)
                }
            }
        }

        return SimpleListenerRegistration {
            task.cancel()
        }
    }

    public func addSnapshotListener(
        options: SnapshotListenOptions,
        listener: @escaping @Sendable (DocumentSnapshot?, Error?) -> Void
    ) -> ListenerRegistration {
        addSnapshotListener(includeMetadataChanges: options.includeMetadataChanges, listener: listener)
    }

    public var snapshots: AsyncThrowingStream<DocumentSnapshot, Error> {
        snapshots(includeMetadataChanges: false)
    }

    public func snapshots(includeMetadataChanges: Bool) -> AsyncThrowingStream<DocumentSnapshot, Error> {
        AsyncThrowingStream { continuation in
            let reg = self.addSnapshotListener(includeMetadataChanges: includeMetadataChanges) { snap, err in
                if let err {
                    continuation.finish(throwing: err)
                } else if let snap {
                    continuation.yield(snap)
                }
            }
            continuation.onTermination = { @Sendable _ in
                reg.remove()
            }
        }
    }

    // ── Conformance Implementations ──────────────────────────────────────────

    public static func == (lhs: DocumentReference, rhs: DocumentReference) -> Bool {
        lhs.path == rhs.path && lhs.firestore === rhs.firestore
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(path)
        hasher.combine(ObjectIdentifier(firestore))
    }
}

private final class CallbackBox<T: Sendable>: @unchecked Sendable {
    let callback: @Sendable (T?, Error?) -> Void
    init(_ callback: @escaping @Sendable (T?, Error?) -> Void) {
        self.callback = callback
    }
}

private final class ErrorCallbackBox: @unchecked Sendable {
    let callback: (@Sendable (Error?) -> Void)?
    init(_ callback: (@Sendable (Error?) -> Void)?) {
        self.callback = callback
    }
}
