import Foundation

public class Query: @unchecked Sendable {

    public let firestore: Firestore
    public let rootSource: TargetDescriptor
    public let path: String
    public let constraints: [QueryConstraintDescriptor]

    public var isCollectionGroup: Bool {
        if case .group = rootSource { return true }
        return false
    }

    public var collectionID: String {
        switch rootSource {
        case .group(let gid):
            return gid
        case .collection(let p):
            return p.components(separatedBy: "/").last ?? ""
        default:
            return path.components(separatedBy: "/").last ?? ""
        }
    }

    public init(
        firestore: Firestore,
        rootSource: TargetDescriptor,
        path: String = "",
        constraints: [QueryConstraintDescriptor] = []
    ) {
        self.firestore = firestore
        self.rootSource = rootSource
        self.path = path
        self.constraints = constraints
    }

    // ── Internal Functional Derivation ───────────────────────────────────────

    internal func copyWithConstraint(_ constraint: QueryConstraintDescriptor) -> Query {
        var updated = self.constraints
        updated.append(constraint)
        return Query(
            firestore: self.firestore,
            rootSource: self.rootSource,
            path: self.path,
            constraints: updated
        )
    }

    internal func copyReplacingConstraint(
        kind: String,
        with newConstraint: QueryConstraintDescriptor?
    ) -> Query {
        var updated = self.constraints.filter { descriptor in
            switch (descriptor, kind) {
            case (.limit, "limit"), (.limitToLast, "limit"):
                return false
            case (.startAt, "start"), (.startAfter, "start"):
                return false
            case (.endAt, "end"), (.endBefore, "end"):
                return false
            default:
                return true
            }
        }
        if let newConstraint {
            updated.append(newConstraint)
        }
        return Query(
            firestore: self.firestore,
            rootSource: self.rootSource,
            path: self.path,
            constraints: updated
        )
    }

    public func compileTarget() -> TargetDescriptor {
        (try? QueryCompiler.compile(query: self)) ?? rootSource
    }

    // ── Filter Methods ───────────────────────────────────────────────────────

    public func whereField(_ field: String, isEqualTo value: Any) -> Query {
        whereField(FieldPath(field: field), isEqualTo: value)
    }

    public func whereField(_ path: FieldPath, isEqualTo value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return copyWithConstraint(.where(field: path.stringValue, op: "==", value: encoded))
    }

    public func whereField(_ field: String, isNotEqualTo value: Any) -> Query {
        whereField(FieldPath(field: field), isNotEqualTo: value)
    }

    public func whereField(_ path: FieldPath, isNotEqualTo value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return copyWithConstraint(.where(field: path.stringValue, op: "!=", value: encoded))
    }

    public func whereField(_ field: String, isLessThan value: Any) -> Query {
        whereField(FieldPath(field: field), isLessThan: value)
    }

    public func whereField(_ path: FieldPath, isLessThan value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return copyWithConstraint(.where(field: path.stringValue, op: "<", value: encoded))
    }

    public func whereField(_ field: String, isLessThanOrEqualTo value: Any) -> Query {
        whereField(FieldPath(field: field), isLessThanOrEqualTo: value)
    }

    public func whereField(_ path: FieldPath, isLessThanOrEqualTo value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return copyWithConstraint(.where(field: path.stringValue, op: "<=", value: encoded))
    }

    public func whereField(_ field: String, isGreaterThan value: Any) -> Query {
        whereField(FieldPath(field: field), isGreaterThan: value)
    }

    public func whereField(_ path: FieldPath, isGreaterThan value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return copyWithConstraint(.where(field: path.stringValue, op: ">", value: encoded))
    }

    public func whereField(_ field: String, isGreaterThanOrEqualTo value: Any) -> Query {
        whereField(FieldPath(field: field), isGreaterThanOrEqualTo: value)
    }

    public func whereField(_ path: FieldPath, isGreaterThanOrEqualTo value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return copyWithConstraint(.where(field: path.stringValue, op: ">=", value: encoded))
    }

    public func whereField(_ field: String, arrayContains value: Any) -> Query {
        whereField(FieldPath(field: field), arrayContains: value)
    }

    public func whereField(_ path: FieldPath, arrayContains value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return copyWithConstraint(.where(field: path.stringValue, op: "array-contains", value: encoded))
    }

    public func whereField(_ field: String, arrayContainsAny values: [Any]) -> Query {
        whereField(FieldPath(field: field), arrayContainsAny: values)
    }

    public func whereField(_ path: FieldPath, arrayContainsAny values: [Any]) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(values))
        return copyWithConstraint(.where(field: path.stringValue, op: "array-contains-any", value: encoded))
    }

    public func whereField(_ field: String, in values: [Any]) -> Query {
        whereField(FieldPath(field: field), in: values)
    }

    public func whereField(_ path: FieldPath, in values: [Any]) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(values))
        return copyWithConstraint(.where(field: path.stringValue, op: "in", value: encoded))
    }

    public func whereField(_ field: String, notIn values: [Any]) -> Query {
        whereField(FieldPath(field: field), notIn: values)
    }

    public func whereField(_ path: FieldPath, notIn values: [Any]) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(values))
        return copyWithConstraint(.where(field: path.stringValue, op: "not-in", value: encoded))
    }

    public func whereFilter(_ filter: Filter) -> Query {
        copyWithConstraint(filter.toConstraintDescriptor())
    }

    // ── Ordering & Limits ────────────────────────────────────────────────────

    public func order(by field: String) -> Query {
        order(by: field, descending: false)
    }

    public func order(by field: String, descending: Bool) -> Query {
        order(by: FieldPath(field: field), descending: descending)
    }

    public func order(by path: FieldPath) -> Query {
        order(by: path, descending: false)
    }

    public func order(by path: FieldPath, descending: Bool) -> Query {
        copyWithConstraint(.orderBy(field: path.stringValue, direction: descending ? "desc" : nil))
    }

    public func limit(to limit: Int) -> Query {
        precondition(limit > 0, "limit must be greater than 0")
        return copyReplacingConstraint(kind: "limit", with: .limit(n: limit))
    }

    public func limit(toLast limit: Int) -> Query {
        precondition(limit > 0, "limit must be greater than 0")
        return copyReplacingConstraint(kind: "limit", with: .limitToLast(n: limit))
    }

    // ── Cursors ──────────────────────────────────────────────────────────────

    public func start(at values: [Any]) -> Query {
        let sendables = values.map { AnySendable.from(try? ValueCodec.encodeValue($0)) }
        return copyReplacingConstraint(kind: "start", with: .startAt(values: sendables))
    }

    public func start(after values: [Any]) -> Query {
        let sendables = values.map { AnySendable.from(try? ValueCodec.encodeValue($0)) }
        return copyReplacingConstraint(kind: "start", with: .startAfter(values: sendables))
    }

    public func end(before values: [Any]) -> Query {
        let sendables = values.map { AnySendable.from(try? ValueCodec.encodeValue($0)) }
        return copyReplacingConstraint(kind: "end", with: .endBefore(values: sendables))
    }

    public func end(at values: [Any]) -> Query {
        let sendables = values.map { AnySendable.from(try? ValueCodec.encodeValue($0)) }
        return copyReplacingConstraint(kind: "end", with: .endAt(values: sendables))
    }

    public func start(atDocument document: DocumentSnapshot) -> Query {
        let values = extractCursorValues(from: document)
        return start(at: values)
    }

    public func start(afterDocument document: DocumentSnapshot) -> Query {
        let values = extractCursorValues(from: document)
        return start(after: values)
    }

    public func end(beforeDocument document: DocumentSnapshot) -> Query {
        let values = extractCursorValues(from: document)
        return end(before: values)
    }

    public func end(atDocument document: DocumentSnapshot) -> Query {
        let values = extractCursorValues(from: document)
        return end(at: values)
    }

    private func extractCursorValues(from document: DocumentSnapshot) -> [Any] {
        let orderBys = constraints.compactMap { constraint -> String? in
            if case .orderBy(let field, _) = constraint { return field }
            return nil
        }

        if orderBys.isEmpty {
            return [document.documentID]
        }

        var cursorValues: [Any] = []
        var containsKey = false

        for field in orderBys {
            if field == "__name__" || field == FieldPath.documentID().stringValue {
                cursorValues.append(document.documentID)
                containsKey = true
            } else if let val = document.get(field) {
                cursorValues.append(val)
            } else {
                cursorValues.append(document.documentID)
            }
        }

        if !containsKey && cursorValues.isEmpty {
            cursorValues.append(document.documentID)
        }

        return cursorValues
    }

    // ── Document Retrieval & Streams ─────────────────────────────────────────

    public func getDocuments(source: FirestoreSource = .default) async throws -> QuerySnapshot {
        let target = try QueryCompiler.compile(query: self)
        let raw = try await firestore.bridgeClient.getDocs(source: target)
        return QuerySnapshot.fromWire(firestore: firestore, query: self, wire: raw)
    }

    public func getDocuments(completion: @escaping @Sendable (QuerySnapshot?, Error?) -> Void) {
        getDocuments(source: .default, completion: completion)
    }

    public func getDocuments(
        source: FirestoreSource,
        completion: @escaping @Sendable (QuerySnapshot?, Error?) -> Void
    ) {
        let target = compileTarget()
        let db = self.firestore
        let box = CallbackBox(completion)
        Task {
            do {
                let raw = try await db.bridgeClient.getDocs(source: target)
                let snapshot = QuerySnapshot.fromWire(firestore: db, query: self, wire: raw)
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

    public func addSnapshotListener(
        _ listener: @escaping @Sendable (QuerySnapshot?, Error?) -> Void
    ) -> ListenerRegistration {
        addSnapshotListener(includeMetadataChanges: false, listener: listener)
    }

    public func addSnapshotListener(
        includeMetadataChanges: Bool,
        listener: @escaping @Sendable (QuerySnapshot?, Error?) -> Void
    ) -> ListenerRegistration {
        let target = compileTarget()
        let db = self.firestore
        let box = CallbackBox(listener)

        let stream = db.bridgeClient.subscribe(
            target: target,
            includeMetadataChanges: includeMetadataChanges
        )

        let task = Task {
            var previousDocs: [QueryDocumentSnapshot]?
            do {
                for try await event in stream {
                    let snapshot = QuerySnapshot.fromWire(
                        firestore: db,
                        query: self,
                        wire: event,
                        previousDocs: previousDocs
                    )
                    previousDocs = snapshot.documents
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
        listener: @escaping @Sendable (QuerySnapshot?, Error?) -> Void
    ) -> ListenerRegistration {
        addSnapshotListener(includeMetadataChanges: options.includeMetadataChanges, listener: listener)
    }

    public var snapshots: AsyncThrowingStream<QuerySnapshot, Error> {
        snapshots(includeMetadataChanges: false)
    }

    public func snapshots(includeMetadataChanges: Bool) -> AsyncThrowingStream<QuerySnapshot, Error> {
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

    // ── Aggregations ─────────────────────────────────────────────────────────

    public var count: AggregateQuery {
        AggregateQuery(query: self, aggregateFields: [AggregateField.count()])
    }

    public func aggregate(_ aggregateFields: [AggregateField]) -> AggregateQuery {
        AggregateQuery(query: self, aggregateFields: aggregateFields)
    }

    public func aggregate(_ field1: AggregateField, _ fields: AggregateField...) -> AggregateQuery {
        var all = [field1]
        all.append(contentsOf: fields)
        return aggregate(all)
    }
}

private final class CallbackBox<T: Sendable>: @unchecked Sendable {
    let callback: @Sendable (T?, Error?) -> Void
    init(_ callback: @escaping @Sendable (T?, Error?) -> Void) {
        self.callback = callback
    }
}
