import Foundation
import Testing
@testable import PyricFirestore

// MARK: - Atomic Counter for Thread-Safe Test Assertions

final class AtomicCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count: Int = 0

    init(_ initial: Int = 0) {
        self.count = initial
    }

    @discardableResult
    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return count
    }

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}

// MARK: - Adversarial Mock Harness

final class AdversarialMockHarness: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var incomingQueue: [String] = []
    private var receiveContinuations: [CheckedContinuation<String, Error>] = []

    var sentMessages: [[String: AnySendable]] = []
    var isClosed: Bool = false

    var onWorkerOp: (@Sendable (_ id: String, _ method: String, _ op: [String: AnySendable]) -> [String: Any]?)?

    private(set) var client: PyricBridgeClient!
    private(set) var firestore: Firestore!

    init() {}

    func send(_ string: String) async throws {
        let (response, continuation) = try handleSendSync(string)
        if let continuation, let response {
            continuation.resume(returning: response)
        }
    }

    private func handleSendSync(_ string: String) throws -> (String?, CheckedContinuation<String, Error>?) {
        lock.lock()
        defer { lock.unlock() }

        guard !isClosed else {
            throw PyricBridgeError.unavailable("WebSocket is closed.")
        }

        guard let data = string.data(using: .utf8),
              let json = try? JSONDecoder().decode(AnySendable.self, from: data),
              let dict = json.dictionaryValue else {
            return (nil, nil)
        }

        sentMessages.append(dict)

        let type = dict["type"]?.stringValue
        var responseString: String? = nil

        if type == "attach" {
            responseString = encodeDict([
                "type": "attach-ack",
                "protocol": 1,
                "bridgeVersion": "0.1.0",
                "peerConnected": true
            ])
        } else if type == "worker-op" {
            let id = dict["id"]?.stringValue ?? ""
            let op = dict["op"]?.dictionaryValue ?? [:]
            let method = op["method"]?.stringValue ?? ""

            if let customResponse = onWorkerOp?(id, method, op) {
                responseString = encodeDict(customResponse)
            } else {
                responseString = defaultWorkerOpResponse(id: id, method: method, op: op)
            }
        } else if type == "ping" {
            let id = dict["id"]?.stringValue ?? ""
            responseString = encodeDict(["type": "pong", "id": id])
        }

        if let responseString {
            if !receiveContinuations.isEmpty {
                let cont = receiveContinuations.removeFirst()
                return (responseString, cont)
            } else {
                incomingQueue.append(responseString)
            }
        }

        return (nil, nil)
    }

    private func defaultWorkerOpResponse(id: String, method: String, op: [String: AnySendable]) -> String {
        switch method {
        case "getDoc":
            let path = op["path"]?.stringValue ?? "test/doc"
            let docId = path.split(separator: "/").last.map(String.init) ?? "doc"
            return encodeDict([
                "type": "worker-res",
                "id": id,
                "ok": true,
                "value": [
                    "id": docId,
                    "path": path,
                    "exists": true,
                    "data": ["json": "{\"val\":1}"]
                ] as [String: Any]
            ])
        case "getDocs":
            return encodeDict([
                "type": "worker-res",
                "id": id,
                "ok": true,
                "value": [
                    "docs": [] as [Any]
                ] as [String: Any]
            ])
        default:
            // setDoc, updateDoc, deleteDoc, batchCommit, txnCommit
            return encodeDict([
                "type": "worker-res",
                "id": id,
                "ok": true,
                "value": NSNull()
            ])
        }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            handleReceiveSync(continuation)
        }
    }

    private func handleReceiveSync(_ continuation: CheckedContinuation<String, Error>) {
        lock.lock()
        defer { lock.unlock() }

        if isClosed {
            continuation.resume(throwing: PyricBridgeError.unavailable("Closed"))
            return
        }
        if !incomingQueue.isEmpty {
            let msg = incomingQueue.removeFirst()
            continuation.resume(returning: msg)
        } else {
            receiveContinuations.append(continuation)
        }
    }

    func close(closeCode: Int = 1000, reason: String? = nil) async {
        let continuations = handleCloseSync()
        for cont in continuations {
            cont.resume(throwing: PyricBridgeError.unavailable("Closed"))
        }
    }

    private func handleCloseSync() -> [CheckedContinuation<String, Error>] {
        lock.lock()
        defer { lock.unlock() }

        isClosed = true
        let continuations = receiveContinuations
        receiveContinuations.removeAll()
        incomingQueue.removeAll()
        return continuations
    }

    private func encodeDict(_ dict: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return str
    }

    static func create() async throws -> AdversarialMockHarness {
        let harness = AdversarialMockHarness()
        let client = PyricBridgeClient(channel: harness)
        try await client.connect()
        let firestore = Firestore(bridgeClient: client)
        harness.client = client
        harness.firestore = firestore
        return harness
    }
}

// MARK: - Adversarial Stress Test Suite

@Suite("Milestone 4 Adversarial Stress Tests")
struct M4AdversarialStressTests {

    // ── 1. Query Compilation & Complex Filters ───────────────────────────────

    @Test("Nested composite filters compile faithfully to TargetDescriptor AST")
    func testNestedCompositeFilters() async throws {
        let harness = try await AdversarialMockHarness.create()

        // 1. Variadic and array composite filters: Filter.andFilter([Filter.orFilter([...])])
        let nested1 = Filter.andFilter([
            Filter.orFilter([
                Filter.whereField("status", isEqualTo: "urgent"),
                Filter.whereField("priority", isGreaterThan: 5)
            ]),
            Filter.whereField("archived", isEqualTo: false),
            Filter.orFilter([
                Filter.whereField("team", isEqualTo: "ios"),
                Filter.whereField("team", isEqualTo: "platform")
            ])
        ])

        let q1 = harness.firestore.collection("tasks").whereFilter(nested1)
        let target1 = q1.compileTarget().toAnySendable()
        let constraints1 = target1["constraints"]?.arrayValue ?? []

        #expect(constraints1.count == 1)
        let rootAnd = constraints1[0]
        #expect(rootAnd["kind"]?.stringValue == "and")
        let andFilters = rootAnd["filters"]?.arrayValue ?? []
        #expect(andFilters.count == 3)
        #expect(andFilters[0]["kind"]?.stringValue == "or")
        #expect(andFilters[1]["kind"]?.stringValue == "where")
        #expect(andFilters[2]["kind"]?.stringValue == "or")

        let firstOrChildren = andFilters[0]["filters"]?.arrayValue ?? []
        #expect(firstOrChildren.count == 2)
        #expect(firstOrChildren[0]["field"]?.stringValue == "status")
        #expect(firstOrChildren[0]["op"]?.stringValue == "==")
        #expect(firstOrChildren[1]["field"]?.stringValue == "priority")
        #expect(firstOrChildren[1]["op"]?.stringValue == ">")

        // 2. 3-layer deep nesting: OR(AND(A, OR(B, C)), D)
        let deep = Filter.or(
            Filter.and(
                Filter.whereField("a", isEqualTo: 1),
                Filter.or(
                    Filter.whereField("b", isEqualTo: 2),
                    Filter.whereField("c", isEqualTo: 3)
                )
            ),
            Filter.whereField("d", isEqualTo: 4)
        )

        let qDeep = harness.firestore.collection("items").whereFilter(deep)
        let targetDeep = qDeep.compileTarget().toAnySendable()
        let constraintsDeep = targetDeep["constraints"]?.arrayValue ?? []
        #expect(constraintsDeep.count == 1)

        let deepOr = constraintsDeep[0]
        #expect(deepOr["kind"]?.stringValue == "or")
        let deepOrChildren = deepOr["filters"]?.arrayValue ?? []
        #expect(deepOrChildren.count == 2)

        let deepAnd = deepOrChildren[0]
        #expect(deepAnd["kind"]?.stringValue == "and")
        let deepAndChildren = deepAnd["filters"]?.arrayValue ?? []
        #expect(deepAndChildren.count == 2)
        #expect(deepAndChildren[0]["field"]?.stringValue == "a")

        let innerOr = deepAndChildren[1]
        #expect(innerOr["kind"]?.stringValue == "or")
        let innerOrChildren = innerOr["filters"]?.arrayValue ?? []
        #expect(innerOrChildren.count == 2)
        #expect(innerOrChildren[0]["field"]?.stringValue == "b")
        #expect(innerOrChildren[1]["field"]?.stringValue == "c")
    }

    @Test("Multiple whereField constraints covering all 10 operators and FieldPath")
    func testMultipleWhereFieldConstraintsAllOperators() async throws {
        let harness = try await AdversarialMockHarness.create()

        let nestedPath = FieldPath(["profile", "stats", "reputation"])

        let query = harness.firestore.collection("users")
            .whereField("a", isLessThan: 10)
            .whereField("b", isLessThanOrEqualTo: 20)
            .whereField("c", isEqualTo: "exact")
            .whereField("d", isNotEqualTo: "excluded")
            .whereField("e", isGreaterThanOrEqualTo: 50)
            .whereField("f", isGreaterThan: 100)
            .whereField("tags", arrayContains: "developer")
            .whereField("skills", arrayContainsAny: ["swift", "rust"])
            .whereField("status", in: ["active", "trial"])
            .whereField("tier", notIn: ["banned", "deleted"])
            .whereField(nestedPath, isGreaterThan: 500)

        let target = query.compileTarget().toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.count == 11)

        let ops = constraints.compactMap { $0["op"]?.stringValue }
        #expect(ops == ["<", "<=", "==", "!=", ">=", ">", "array-contains", "array-contains-any", "in", "not-in", ">"])

        let fields = constraints.compactMap { $0["field"]?.stringValue }
        #expect(fields == ["a", "b", "c", "d", "e", "f", "tags", "skills", "status", "tier", "profile.stats.reputation"])
    }

    @Test("Ordering and pagination cursors with replacement semantics")
    func testOrderingAndPaginationCursors() async throws {
        let harness = try await AdversarialMockHarness.create()

        // 1. Chained order(by:) with ascending and descending
        var query = harness.firestore.collection("scores")
            .order(by: "level", descending: false)
            .order(by: "points", descending: true)
            .order(by: FieldPath(["meta", "time"]), descending: false)

        var target = query.compileTarget().toAnySendable()
        var constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.count == 3)
        #expect(constraints[0]["field"]?.stringValue == "level" && constraints[0]["direction"] == nil)
        #expect(constraints[1]["field"]?.stringValue == "points" && constraints[1]["direction"]?.stringValue == "desc")
        #expect(constraints[2]["field"]?.stringValue == "meta.time" && constraints[2]["direction"] == nil)

        // 2. Cursor replacement: calling start(after:) replaces prior start(at:)
        query = query.start(at: [1, 100]).start(after: [2, 200])
        target = query.compileTarget().toAnySendable()
        constraints = target["constraints"]?.arrayValue ?? []
        let startConstraints = constraints.filter {
            $0["kind"]?.stringValue == "startAt" || $0["kind"]?.stringValue == "startAfter"
        }
        #expect(startConstraints.count == 1)
        #expect(startConstraints[0]["kind"]?.stringValue == "startAfter")
        #expect(startConstraints[0]["values"]?.arrayValue?.count == 2)

        // 3. Cursor replacement: calling end(at:) replaces prior end(before:)
        query = query.end(before: [5, 500]).end(at: [6, 600])
        target = query.compileTarget().toAnySendable()
        constraints = target["constraints"]?.arrayValue ?? []
        let endConstraints = constraints.filter {
            $0["kind"]?.stringValue == "endBefore" || $0["kind"]?.stringValue == "endAt"
        }
        #expect(endConstraints.count == 1)
        #expect(endConstraints[0]["kind"]?.stringValue == "endAt")

        // 4. Limit replacement: calling limit(to: 50) replaces prior limit(to: 10)
        query = query.limit(to: 10).limit(to: 50)
        target = query.compileTarget().toAnySendable()
        constraints = target["constraints"]?.arrayValue ?? []
        let limitConstraints = constraints.filter { $0["kind"]?.stringValue == "limit" }
        #expect(limitConstraints.count == 1)
        #expect(limitConstraints[0]["n"]?.intValue == 50)

        // 5. DocumentSnapshot cursor extraction across multiple orderBys
        let snap = DocumentSnapshot(
            firestore: harness.firestore,
            path: "scores/doc99",
            data: ["level": 3, "points": 999]
        )
        let docCursorQuery = harness.firestore.collection("scores")
            .order(by: "level")
            .order(by: "points")
            .start(atDocument: snap)
        let docTarget = docCursorQuery.compileTarget().toAnySendable()
        let docConstraints = docTarget["constraints"]?.arrayValue ?? []
        let docStart = docConstraints.first { $0["kind"]?.stringValue == "startAt" }
        let cursorValues = docStart?["values"]?.arrayValue ?? []
        #expect(cursorValues.count == 2)
        #expect(cursorValues[0].intValue == 3)
        #expect(cursorValues[1].intValue == 999)
    }

    @Test("limit(toLast:) strictly enforces explicit orderBy clause")
    func testLimitToLastEnforcement() async throws {
        let harness = try await AdversarialMockHarness.create()

        // 1. Without orderBy, QueryCompiler.compile MUST throw invalidArgument
        let invalidQuery = harness.firestore.collection("messages").limit(toLast: 10)
        #expect(throws: PyricFirestoreError.self) {
            try QueryCompiler.compile(query: invalidQuery)
        }

        // 2. getDocuments() on invalidQuery must fail
        await #expect(throws: PyricFirestoreError.self) {
            try await invalidQuery.getDocuments()
        }

        // 3. With orderBy, compilation succeeds and emits limitToLast constraint
        let validQuery = harness.firestore.collection("messages")
            .order(by: "timestamp")
            .limit(toLast: 10)
        let target = try QueryCompiler.compile(query: validQuery).toAnySendable()
        let constraints = target["constraints"]?.arrayValue ?? []
        #expect(constraints.contains(where: {
            $0["kind"]?.stringValue == "limitToLast" && $0["n"]?.intValue == 10
        }))
    }

    // ── 2. WriteBatch and Transactions ───────────────────────────────────────

    @Test("WriteBatch accurately stages operations preserving order and options")
    func testWriteBatchOperations() async throws {
        let harness = try await AdversarialMockHarness.create()
        let batch = harness.firestore.batch()

        let doc1 = harness.firestore.document("coll/1")
        let doc2 = harness.firestore.document("coll/2")
        let doc3 = harness.firestore.document("coll/3")
        let doc4 = harness.firestore.document("coll/4")
        let doc5 = harness.firestore.document("coll/5")

        // 1. Set (overwrite)
        batch.setData(["title": "Doc 1"], forDocument: doc1)
        // 2. Set (merge)
        batch.setData(["author": "Alice"], forDocument: doc2, merge: true)
        // 3. Set (mergeFields)
        batch.setData(["count": 42, "ignored": "yes"], forDocument: doc3, mergeFields: ["count"])
        // 4. Update (String and FieldPath)
        batch.updateData([
            "views": 100,
            FieldPath(["nested", "flag"]): true
        ], forDocument: doc4)
        // 5. Delete
        batch.deleteDocument(doc5)

        try await batch.commit()

        let lastOp = harness.sentMessages.last(where: { $0["type"]?.stringValue == "worker-op" })
        let opDict = lastOp?["op"]?.dictionaryValue
        #expect(opDict?["method"]?.stringValue == "batchCommit")

        let writes = opDict?["writes"]?.arrayValue ?? []
        #expect(writes.count == 5)

        #expect(writes[0]["method"]?.stringValue == "set" && writes[0]["path"]?.stringValue == "coll/1")
        #expect(writes[1]["options"]?["merge"]?.boolValue == true)
        #expect(writes[2]["options"]?["mergeFields"]?.arrayValue?.contains(.string("count")) == true)
        #expect(writes[3]["method"]?.stringValue == "update" && writes[3]["path"]?.stringValue == "coll/4")
        #expect(writes[4]["method"]?.stringValue == "delete" && writes[4]["path"]?.stringValue == "coll/5")

        // 6. Committing an already committed batch must throw invalidArgument
        await #expect(throws: PyricFirestoreError.self) {
            try await batch.commit()
        }
    }

    @Test("WriteBatch supports up to 500 operations and enforces 500 limit")
    func testWriteBatch500Limit() async throws {
        let harness = try await AdversarialMockHarness.create()
        let batch = harness.firestore.batch()

        // Enqueue exactly 500 writes
        for i in 0..<500 {
            let doc = harness.firestore.document("bulk/\(i)")
            if i % 3 == 0 {
                batch.setData(["index": i], forDocument: doc)
            } else if i % 3 == 1 {
                batch.updateData(["index": i], forDocument: doc)
            } else {
                batch.deleteDocument(doc)
            }
        }

        try await batch.commit()

        let lastOp = harness.sentMessages.last(where: { $0["type"]?.stringValue == "worker-op" })
        let writes = lastOp?["op"]?["writes"]?.arrayValue ?? []
        #expect(writes.count == 500)
    }

    @Test("Transaction enforces read-before-write invariant")
    func testTransactionReadBeforeWriteInvariant() async throws {
        let harness = try await AdversarialMockHarness.create()

        await #expect(throws: PyricBridgeError.self) {
            _ = try await harness.firestore.runTransaction { txn in
                // Write first:
                txn.setData(["name": "Bob"], forDocument: harness.firestore.document("users/bob"))
                // Read afterwards must fail:
                _ = try await txn.getDocument(harness.firestore.document("users/alice"))
                return nil
            }
        }
    }

    @Test("Transaction retries on conflict (aborted / failedPrecondition) and succeeds")
    func testTransactionConflictRetrySuccess() async throws {
        let harness = try await AdversarialMockHarness.create()

        let attemptCounter = AtomicCounter(0)

        harness.onWorkerOp = { id, method, op in
            if method == "txnCommit" {
                let attempt = attemptCounter.increment()
                if attempt == 1 {
                    // Attempt 1: conflict aborted
                    return [
                        "type": "worker-res",
                        "id": id,
                        "ok": false,
                        "error": [
                            "code": "aborted",
                            "message": "Transaction conflict, document was modified concurrently."
                        ]
                    ]
                } else if attempt == 2 {
                    // Attempt 2: failed precondition
                    return [
                        "type": "worker-res",
                        "id": id,
                        "ok": false,
                        "error": [
                            "code": "failed-precondition",
                            "message": "Optimistic concurrency check failed."
                        ]
                    ]
                } else {
                    // Attempt 3: success
                    return [
                        "type": "worker-res",
                        "id": id,
                        "ok": true,
                        "value": NSNull()
                    ]
                }
            }
            return nil
        }

        let executedBlockCounter = AtomicCounter(0)
        let result = try await harness.firestore.runTransaction { txn in
            executedBlockCounter.increment()
            let snap = try await txn.getDocument(harness.firestore.document("users/alice"))
            txn.setData(["age": 35], forDocument: harness.firestore.document("users/alice"))
            return "success-\(snap.documentID)"
        }

        #expect(result as? String == "success-alice")
        #expect(executedBlockCounter.value == 3)
        #expect(attemptCounter.value == 3)
    }

    @Test("Transaction exhausts maxAttempts and throws final error")
    func testTransactionMaxAttemptsExhausted() async throws {
        let harness = try await AdversarialMockHarness.create()

        let attemptCounter = AtomicCounter(0)
        harness.onWorkerOp = { id, method, op in
            if method == "txnCommit" {
                attemptCounter.increment()
                return [
                    "type": "worker-res",
                    "id": id,
                    "ok": false,
                    "error": [
                        "code": "aborted",
                        "message": "Persistent contention conflict."
                    ]
                ]
            }
            return nil
        }

        let options = TransactionOptions(maxAttempts: 3)
        let executedBlockCounter = AtomicCounter(0)

        await #expect(throws: PyricBridgeError.self) {
            _ = try await harness.firestore.runTransaction(options: options) { txn in
                executedBlockCounter.increment()
                txn.setData(["val": 1], forDocument: harness.firestore.document("locks/resource"))
                return nil
            }
        }

        #expect(executedBlockCounter.value == 3)
        #expect(attemptCounter.value == 3)
    }

    @Test("Transaction does not retry non-retryable errors like permissionDenied")
    func testTransactionNonRetryableError() async throws {
        let harness = try await AdversarialMockHarness.create()

        let attemptCounter = AtomicCounter(0)
        harness.onWorkerOp = { id, method, op in
            if method == "txnCommit" {
                attemptCounter.increment()
                return [
                    "type": "worker-res",
                    "id": id,
                    "ok": false,
                    "error": [
                        "code": "permission-denied",
                        "message": "Rules check failed: Missing write authorization."
                    ]
                ]
            }
            return nil
        }

        let executedBlockCounter = AtomicCounter(0)

        await #expect(throws: PyricBridgeError.self) {
            _ = try await harness.firestore.runTransaction { txn in
                executedBlockCounter.increment()
                txn.setData(["val": 1], forDocument: harness.firestore.document("secret/doc"))
                return nil
            }
        }

        #expect(executedBlockCounter.value == 1)
        #expect(attemptCounter.value == 1)
    }
}
