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

    // -- Subcollections --

    public func collection(_ collectionPath: String) -> CollectionReference {
        firestore.markUsed()
        let clean = collectionPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let segments = clean.components(separatedBy: "/")
        precondition(
            !clean.isEmpty && segments.count % 2 == 1,
            "Invalid subcollection path '\(collectionPath)'. Must have an odd number of segments."
        )
        return CollectionReference(firestore: firestore, path: "\(path)/\(clean)")
    }

    // -- Retrieving Data --

    public func getDocument(source: FirestoreSource = .default) async throws -> DocumentSnapshot {
        try await getDocument(turn: firestore.takeTurn(), source: source)
    }

    private func getDocument(turn: OperationTurn, source: FirestoreSource) async throws -> DocumentSnapshot {
        let client = firestore.bridgeClient
        await client.acquireTurn(turn)
        if await client.isDisposed {
            await client.finishTurn(turn)
            throw PyricBridgeError.unavailable("PyricBridgeClient has been disposed.")
        }
        do {
            try firestore.lifecycle.ensureActiveAndMarkStarted()
        } catch {
            await client.finishTurn(turn)
            throw error
        }
        firestore.markUsed()

        if source == .cache || (source == .default && !firestore.lifecycle.isNetworkEnabled) {
            do {
                let cachedWire = try firestore.lifecycle.readCachedDocumentWire(path: path)
                await client.finishTurn(turn)
                return DocumentSnapshot.fromWire(firestore: firestore, path: path, wire: cachedWire, isFromCache: true)
            } catch {
                await client.finishTurn(turn)
                throw error
            }
        }
        if source == .server && !firestore.lifecycle.isNetworkEnabled {
            await client.finishTurn(turn)
            throw PyricBridgeError.unavailable("Failed to get document because the client is offline.")
        }

        let raw = try await client.getDoc(turn: turn, path: path, actAs: firestore.effectiveAuthLens)
        firestore.lifecycle.recordOnlineDocWire(path: path, wire: raw)
        return DocumentSnapshot.fromWire(firestore: firestore, path: path, wire: raw)
    }

    public func getDocument(completion: @escaping @Sendable (DocumentSnapshot?, Error?) -> Void) {
        getDocument(source: .default, completion: completion)
    }

    public func getDocument(
        source: FirestoreSource,
        completion: @escaping @Sendable (DocumentSnapshot?, Error?) -> Void
    ) {
        firestore.runInCallOrder(completion: completion) { turn in
            try await self.getDocument(turn: turn, source: source)
        }
    }

    // -- Writing Data --

    public func setData(_ data: [String: Any], merge: Bool = false) async throws {
        let options = SetOptionsWire(merge: merge)
        let encoded = try ValueCodec.encodeWriteData(data)
        let encodedSendable = AnySendable.from(encoded)
        let params = PyricBridgeClient.setDocParams(path: path, data: encodedSendable, options: options)
        let mutation = OfflineWriteMutation.set(
            path: path,
            encodedData: encodedSendable.dictionaryValue ?? [:],
            merge: merge,
            mergeFields: nil
        )
        try await firestore.send(turn: firestore.takeTurn(), method: "setDoc", params: params, mutations: [mutation])
    }

    public func setData(_ data: [String: Any], mergeFields: [Any]) async throws {
        let fieldStrings = try validateMergeFields(data: data, mergeFields: mergeFields)
        let options = SetOptionsWire(merge: nil, mergeFields: fieldStrings)
        let encoded = try ValueCodec.encodeWriteData(data)
        let encodedSendable = AnySendable.from(encoded)
        let params = PyricBridgeClient.setDocParams(path: path, data: encodedSendable, options: options)
        let mutation = OfflineWriteMutation.set(
            path: path,
            encodedData: encodedSendable.dictionaryValue ?? [:],
            merge: false,
            mergeFields: fieldStrings
        )
        try await firestore.send(turn: firestore.takeTurn(), method: "setDoc", params: params, mutations: [mutation])
    }

    public func setData(_ data: [String: Any], completion: (@Sendable (Error?) -> Void)? = nil) {
        setData(data, merge: false, completion: completion)
    }

    public func setData(_ data: [String: Any], merge: Bool, completion: (@Sendable (Error?) -> Void)? = nil) {
        do {
            let options = SetOptionsWire(merge: merge)
            let encoded = try ValueCodec.encodeWriteData(data)
            let encodedSendable = AnySendable.from(encoded)
            let params = PyricBridgeClient.setDocParams(path: path, data: encodedSendable, options: options)
            let mutation = OfflineWriteMutation.set(
                path: path,
                encodedData: encodedSendable.dictionaryValue ?? [:],
                merge: merge,
                mergeFields: nil
            )
            firestore.sendInCallOrder(method: "setDoc", params: params, mutations: [mutation], completion: completion)
        } catch {
            firestore.settings.dispatchCallback { completion?(error) }
        }
    }

    public func setData(_ data: [String: Any], mergeFields: [Any], completion: (@Sendable (Error?) -> Void)? = nil) {
        do {
            let fieldStrings = try validateMergeFields(data: data, mergeFields: mergeFields)
            let options = SetOptionsWire(merge: nil, mergeFields: fieldStrings)
            let encoded = try ValueCodec.encodeWriteData(data)
            let encodedSendable = AnySendable.from(encoded)
            let params = PyricBridgeClient.setDocParams(path: path, data: encodedSendable, options: options)
            let mutation = OfflineWriteMutation.set(
                path: path,
                encodedData: encodedSendable.dictionaryValue ?? [:],
                merge: false,
                mergeFields: fieldStrings
            )
            firestore.sendInCallOrder(method: "setDoc", params: params, mutations: [mutation], completion: completion)
        } catch {
            firestore.settings.dispatchCallback { completion?(error) }
        }
    }

    public func updateData(_ fields: [AnyHashable: Any]) async throws {
        let stringDict = try normalizeUpdateFields(fields)
        let encoded = try ValueCodec.encodeWriteData(stringDict)
        let encodedSendable = AnySendable.from(encoded)
        let params = PyricBridgeClient.updateDocParams(path: path, data: encodedSendable)
        let mutation = OfflineWriteMutation.update(path: path, encodedFields: encodedSendable.dictionaryValue ?? [:])
        try await firestore.send(turn: firestore.takeTurn(), method: "updateDoc", params: params, mutations: [mutation])
    }

    public func updateData(_ fields: [AnyHashable: Any], completion: (@Sendable (Error?) -> Void)? = nil) {
        do {
            let stringDict = try normalizeUpdateFields(fields)
            let encoded = try ValueCodec.encodeWriteData(stringDict)
            let encodedSendable = AnySendable.from(encoded)
            let params = PyricBridgeClient.updateDocParams(path: path, data: encodedSendable)
            let mutation = OfflineWriteMutation.update(path: path, encodedFields: encodedSendable.dictionaryValue ?? [:])
            firestore.sendInCallOrder(method: "updateDoc", params: params, mutations: [mutation], completion: completion)
        } catch {
            firestore.settings.dispatchCallback { completion?(error) }
        }
    }

    public func delete() async throws {
        let mutation = OfflineWriteMutation.delete(path: path)
        try await firestore.send(
            turn: firestore.takeTurn(),
            method: "deleteDoc",
            params: PyricBridgeClient.deleteDocParams(path: path),
            mutations: [mutation]
        )
    }

    public func delete(completion: (@Sendable (Error?) -> Void)? = nil) {
        let mutation = OfflineWriteMutation.delete(path: path)
        firestore.sendInCallOrder(
            method: "deleteDoc",
            params: PyricBridgeClient.deleteDocParams(path: path),
            mutations: [mutation],
            completion: completion
        )
    }

    private func validateMergeFields(data: [String: Any], mergeFields: [Any]) throws -> [String] {
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
        return fieldStrings
    }

    private func normalizeUpdateFields(_ fields: [AnyHashable: Any]) throws -> [String: Any] {
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
        return stringDict
    }

    // -- Real-Time Snapshot Listeners --

    public func addSnapshotListener(
        _ listener: @escaping @Sendable (DocumentSnapshot?, Error?) -> Void
    ) -> ListenerRegistration {
        addSnapshotListener(includeMetadataChanges: false, listener: listener)
    }

    public func addSnapshotListener(
        includeMetadataChanges: Bool,
        listener: @escaping @Sendable (DocumentSnapshot?, Error?) -> Void
    ) -> ListenerRegistration {
        firestore.markUsed()
        let box = CallbackBox(listener)
        let docPath = self.path
        let db = self.firestore
        let stateBox = DocListenerStateBox()

        let coordinator = SnapshotSubscriptionCoordinator(
            firestore: db,
            target: .doc(path: docPath),
            includeMetadataChanges: includeMetadataChanges,
            onEvent: { event in
                db.lifecycle.recordOnlineDocWire(path: docPath, wire: event)
                let snapshot = DocumentSnapshot.fromWire(firestore: db, path: docPath, wire: event)
                let shouldSuppressMetadataOnly = stateBox.recordOnlineAndShouldSuppress(
                    snapshot: snapshot,
                    rawWire: event,
                    includeMetadataChanges: includeMetadataChanges
                )
                if shouldSuppressMetadataOnly {
                    db.lifecycle.notifyAlreadyInSyncOnReconnect(settings: db.settings)
                    return
                }
                db.lifecycle.dispatchSnapshotCallback(
                    settings: db.settings,
                    isCancelled: { stateBox.isCancelled }
                ) {
                    box.callback(snapshot, nil)
                }
            },
            onOffline: {
                let wire = db.lifecycle.projectOfflineDocumentWire(path: docPath)
                let snapshot = DocumentSnapshot.fromWire(firestore: db, path: docPath, wire: wire, isFromCache: true)
                stateBox.recordOffline(snapshot: snapshot, rawWire: wire)
                db.lifecycle.dispatchSnapshotCallback(
                    settings: db.settings,
                    isCancelled: { stateBox.isCancelled }
                ) {
                    box.callback(snapshot, nil)
                }
            },
            onGap: {
                guard let wire = stateBox.lastWire else { return }
                let snapshot = DocumentSnapshot.fromWire(firestore: db, path: docPath, wire: wire, isFromCache: true)
                stateBox.recordOffline(snapshot: snapshot, rawWire: wire)
                db.lifecycle.dispatchSnapshotCallback(
                    settings: db.settings,
                    isCancelled: { stateBox.isCancelled }
                ) {
                    box.callback(snapshot, nil)
                }
            },
            onError: { error in
                db.settings.dispatchCallback {
                    guard !stateBox.isCancelled else { return }
                    box.callback(nil, error)
                }
            }
        )

        return SimpleListenerRegistration {
            stateBox.markCancelled()
            coordinator.cancel()
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

    // -- Conformance Implementations --

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

private final class DocListenerStateBox: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var hasDelivered = false
    private var lastFromCache = false
    private var lastExists = false
    private var lastData: [String: Any]?
    private var _lastWire: AnySendable?

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    var lastWire: AnySendable? {
        lock.lock()
        defer { lock.unlock() }
        return _lastWire
    }

    func markCancelled() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    func recordOffline(snapshot: DocumentSnapshot, rawWire: AnySendable) {
        lock.lock()
        hasDelivered = true
        lastFromCache = true
        lastExists = snapshot.exists
        lastData = snapshot.data()
        _lastWire = rawWire
        lock.unlock()
    }

    func recordOnlineAndShouldSuppress(
        snapshot: DocumentSnapshot,
        rawWire: AnySendable,
        includeMetadataChanges: Bool
    ) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let wasCachedSameContent = !includeMetadataChanges
            && hasDelivered
            && lastFromCache
            && !snapshot.metadata.hasPendingWrites
            && snapshot.exists == lastExists
            && NSDictionary(dictionary: snapshot.data() ?? [:]).isEqual(to: lastData ?? [:])
        hasDelivered = true
        lastFromCache = snapshot.metadata.isFromCache
        lastExists = snapshot.exists
        lastData = snapshot.data()
        _lastWire = rawWire
        return wasCachedSameContent
    }
}
