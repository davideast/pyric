import Foundation

internal struct SnapshotCursorSpec: @unchecked Sendable {
    let inclusive: Bool
    let snapshot: DocumentSnapshot
}

public class Query: @unchecked Sendable {

    public let firestore: Firestore
    public let rootSource: TargetDescriptor
    public let path: String
    public let constraints: [QueryConstraintDescriptor]
    internal let startSnapshotCursor: SnapshotCursorSpec?
    internal let endSnapshotCursor: SnapshotCursorSpec?

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
        self.startSnapshotCursor = nil
        self.endSnapshotCursor = nil
    }

    internal init(
        firestore: Firestore,
        rootSource: TargetDescriptor,
        path: String,
        constraints: [QueryConstraintDescriptor],
        startSnapshotCursor: SnapshotCursorSpec?,
        endSnapshotCursor: SnapshotCursorSpec?
    ) {
        self.firestore = firestore
        self.rootSource = rootSource
        self.path = path
        self.constraints = constraints
        self.startSnapshotCursor = startSnapshotCursor
        self.endSnapshotCursor = endSnapshotCursor
    }

    // -- Internal Functional Derivation --

    internal func copyWithConstraint(_ constraint: QueryConstraintDescriptor) -> Query {
        var updated = self.constraints
        updated.append(constraint)
        return Query(
            firestore: self.firestore,
            rootSource: self.rootSource,
            path: self.path,
            constraints: updated,
            startSnapshotCursor: self.startSnapshotCursor,
            endSnapshotCursor: self.endSnapshotCursor
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
        let nextStartSnapshot = (kind == "start") ? nil : self.startSnapshotCursor
        let nextEndSnapshot = (kind == "end") ? nil : self.endSnapshotCursor
        return Query(
            firestore: self.firestore,
            rootSource: self.rootSource,
            path: self.path,
            constraints: updated,
            startSnapshotCursor: nextStartSnapshot,
            endSnapshotCursor: nextEndSnapshot
        )
    }

    internal func copyReplacingSnapshotCursor(
        isStart: Bool,
        spec: SnapshotCursorSpec
    ) -> Query {
        let kind = isStart ? "start" : "end"
        let updated = self.constraints.filter { descriptor in
            switch (descriptor, kind) {
            case (.startAt, "start"), (.startAfter, "start"):
                return false
            case (.endAt, "end"), (.endBefore, "end"):
                return false
            default:
                return true
            }
        }
        return Query(
            firestore: self.firestore,
            rootSource: self.rootSource,
            path: self.path,
            constraints: updated,
            startSnapshotCursor: isStart ? spec : self.startSnapshotCursor,
            endSnapshotCursor: isStart ? self.endSnapshotCursor : spec
        )
    }

    public func compileTarget() -> TargetDescriptor {
        (try? QueryCompiler.compile(query: self)) ?? rootSource
    }

    private func makeFieldWhereConstraint(
        field: String,
        segments: [String]?,
        op: String,
        encoded: AnySendable
    ) -> Query {
        precondition(!field.isEmpty, "Field path must not be empty.")
        let explicitSegments = (segments?.contains { $0.contains(".") } == true) ? segments : nil
        return copyWithConstraint(.where(field: field, fieldSegments: explicitSegments, op: op, value: encoded))
    }

    // -- Filter Methods --

    public func whereField(_ field: String, isEqualTo value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return makeFieldWhereConstraint(field: field, segments: nil, op: "==", encoded: encoded)
    }

    public func whereField(_ path: FieldPath, isEqualTo value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return makeFieldWhereConstraint(field: path.stringValue, segments: path.segments, op: "==", encoded: encoded)
    }

    public func whereField(_ field: String, isNotEqualTo value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return makeFieldWhereConstraint(field: field, segments: nil, op: "!=", encoded: encoded)
    }

    public func whereField(_ path: FieldPath, isNotEqualTo value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return makeFieldWhereConstraint(field: path.stringValue, segments: path.segments, op: "!=", encoded: encoded)
    }

    public func whereField(_ field: String, isLessThan value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return makeFieldWhereConstraint(field: field, segments: nil, op: "<", encoded: encoded)
    }

    public func whereField(_ path: FieldPath, isLessThan value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return makeFieldWhereConstraint(field: path.stringValue, segments: path.segments, op: "<", encoded: encoded)
    }

    public func whereField(_ field: String, isLessThanOrEqualTo value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return makeFieldWhereConstraint(field: field, segments: nil, op: "<=", encoded: encoded)
    }

    public func whereField(_ path: FieldPath, isLessThanOrEqualTo value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return makeFieldWhereConstraint(field: path.stringValue, segments: path.segments, op: "<=", encoded: encoded)
    }

    public func whereField(_ field: String, isGreaterThan value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return makeFieldWhereConstraint(field: field, segments: nil, op: ">", encoded: encoded)
    }

    public func whereField(_ path: FieldPath, isGreaterThan value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return makeFieldWhereConstraint(field: path.stringValue, segments: path.segments, op: ">", encoded: encoded)
    }

    public func whereField(_ field: String, isGreaterThanOrEqualTo value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return makeFieldWhereConstraint(field: field, segments: nil, op: ">=", encoded: encoded)
    }

    public func whereField(_ path: FieldPath, isGreaterThanOrEqualTo value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return makeFieldWhereConstraint(field: path.stringValue, segments: path.segments, op: ">=", encoded: encoded)
    }

    public func whereField(_ field: String, arrayContains value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return makeFieldWhereConstraint(field: field, segments: nil, op: "array-contains", encoded: encoded)
    }

    public func whereField(_ path: FieldPath, arrayContains value: Any) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(value))
        return makeFieldWhereConstraint(field: path.stringValue, segments: path.segments, op: "array-contains", encoded: encoded)
    }

    public func whereField(_ field: String, arrayContainsAny values: [Any]) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(values))
        return makeFieldWhereConstraint(field: field, segments: nil, op: "array-contains-any", encoded: encoded)
    }

    public func whereField(_ path: FieldPath, arrayContainsAny values: [Any]) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(values))
        return makeFieldWhereConstraint(field: path.stringValue, segments: path.segments, op: "array-contains-any", encoded: encoded)
    }

    public func whereField(_ field: String, in values: [Any]) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(values))
        return makeFieldWhereConstraint(field: field, segments: nil, op: "in", encoded: encoded)
    }

    public func whereField(_ path: FieldPath, in values: [Any]) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(values))
        return makeFieldWhereConstraint(field: path.stringValue, segments: path.segments, op: "in", encoded: encoded)
    }

    public func whereField(_ field: String, notIn values: [Any]) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(values))
        return makeFieldWhereConstraint(field: field, segments: nil, op: "not-in", encoded: encoded)
    }

    public func whereField(_ path: FieldPath, notIn values: [Any]) -> Query {
        let encoded = AnySendable.from(try? ValueCodec.encodeValue(values))
        return makeFieldWhereConstraint(field: path.stringValue, segments: path.segments, op: "not-in", encoded: encoded)
    }

    public func whereFilter(_ filter: Filter) -> Query {
        let descriptor = filter.toConstraintDescriptor()
        switch descriptor {
        case .and(let children) where children.isEmpty,
             .or(let children) where children.isEmpty:
            return Query(
                firestore: self.firestore,
                rootSource: self.rootSource,
                path: self.path,
                constraints: self.constraints,
                startSnapshotCursor: self.startSnapshotCursor,
                endSnapshotCursor: self.endSnapshotCursor
            )
        default:
            return copyWithConstraint(descriptor)
        }
    }

    // -- Ordering & Limits --

    public func order(by field: String) -> Query {
        order(by: field, descending: false)
    }

    public func order(by field: String, descending: Bool) -> Query {
        precondition(!field.isEmpty, "Field path must not be empty.")
        return copyWithConstraint(.orderBy(field: field, fieldSegments: nil, direction: descending ? "desc" : nil))
    }

    public func order(by path: FieldPath) -> Query {
        order(by: path, descending: false)
    }

    public func order(by path: FieldPath, descending: Bool) -> Query {
        let explicitSegments = path.segments.contains { $0.contains(".") } ? path.segments : nil
        return copyWithConstraint(
            .orderBy(field: path.stringValue, fieldSegments: explicitSegments, direction: descending ? "desc" : nil)
        )
    }

    public func limit(to limit: Int) -> Query {
        precondition(limit > 0, "limit must be greater than 0")
        return copyReplacingConstraint(kind: "limit", with: .limit(n: limit))
    }

    public func limit(toLast limit: Int) -> Query {
        precondition(limit > 0, "limit must be greater than 0")
        return copyReplacingConstraint(kind: "limit", with: .limitToLast(n: limit))
    }

    // -- Cursors --

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
        copyReplacingSnapshotCursor(isStart: true, spec: SnapshotCursorSpec(inclusive: true, snapshot: document))
    }

    public func start(afterDocument document: DocumentSnapshot) -> Query {
        copyReplacingSnapshotCursor(isStart: true, spec: SnapshotCursorSpec(inclusive: false, snapshot: document))
    }

    public func end(beforeDocument document: DocumentSnapshot) -> Query {
        copyReplacingSnapshotCursor(isStart: false, spec: SnapshotCursorSpec(inclusive: false, snapshot: document))
    }

    public func end(atDocument document: DocumentSnapshot) -> Query {
        copyReplacingSnapshotCursor(isStart: false, spec: SnapshotCursorSpec(inclusive: true, snapshot: document))
    }

    // -- Document Retrieval & Streams --

    public func getDocuments(source: FirestoreSource = .default) async throws -> QuerySnapshot {
        let target = try QueryCompiler.compile(query: self)
        return try await getDocuments(turn: firestore.takeTurn(), target: target, source: source)
    }

    private func getDocuments(
        turn: OperationTurn,
        target: TargetDescriptor,
        source: FirestoreSource
    ) async throws -> QuerySnapshot {
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

        let requestLens = firestore.effectiveAuthLens
        let authScope = requestLens.cacheScopeKey
        if source == .cache || (source == .default && !firestore.lifecycle.isNetworkEnabled) {
            let cachedWire = firestore.lifecycle.projectOfflineQueryWire(target: target, authScope: authScope)
            await client.finishTurn(turn)
            return QuerySnapshot.fromWire(firestore: firestore, query: self, wire: cachedWire, isFromCache: true)
        }
        if source == .server && !firestore.lifecycle.isNetworkEnabled {
            await client.finishTurn(turn)
            throw PyricBridgeError.unavailable("Failed to get documents from server because the client is offline.")
        }

        let raw = try await client.getDocs(turn: turn, source: target, actAs: requestLens)
        firestore.lifecycle.recordOnlineQueryWire(raw, authScope: authScope)
        return QuerySnapshot.fromWire(firestore: firestore, query: self, wire: raw)
    }

    public func getDocuments(completion: @escaping @Sendable (QuerySnapshot?, Error?) -> Void) {
        getDocuments(source: .default, completion: completion)
    }

    public func getDocuments(
        source: FirestoreSource,
        completion: @escaping @Sendable (QuerySnapshot?, Error?) -> Void
    ) {
        let target: TargetDescriptor
        do {
            target = try QueryCompiler.compile(query: self)
        } catch {
            firestore.settings.dispatchCallback { completion(nil, error) }
            return
        }
        firestore.runInCallOrder(completion: completion) { turn in
            try await self.getDocuments(turn: turn, target: target, source: source)
        }
    }
}
