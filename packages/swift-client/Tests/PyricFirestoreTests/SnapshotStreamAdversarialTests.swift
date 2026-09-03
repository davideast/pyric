import Foundation
import Testing
@testable import PyricFirestore

// ── Isolated Adversarial Mock Harness ─────────────────────────────────────────

final class SnapshotStressHarness: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var incomingQueue: [String] = []
    private var receiveContinuations: [CheckedContinuation<String, Error>] = []
    private(set) var sentMessages: [[String: AnySendable]] = []
    private(set) var isClosed: Bool = false

    private func handleSendSync(_ string: String) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !isClosed else { throw PyricBridgeError.unavailable("Closed") }
        if let data = string.data(using: .utf8),
           let obj = try? JSONDecoder().decode(AnySendable.self, from: data),
           let dict = obj.dictionaryValue {
            sentMessages.append(dict)
        }
    }

    func send(_ string: String) async throws {
        try handleSendSync(string)
    }

    private func handleReceiveSync(_ cont: CheckedContinuation<String, Error>) {
        lock.lock()
        defer { lock.unlock() }
        if isClosed {
            cont.resume(throwing: PyricBridgeError.unavailable("Closed"))
        } else if !incomingQueue.isEmpty {
            cont.resume(returning: incomingQueue.removeFirst())
        } else {
            receiveContinuations.append(cont)
        }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            handleReceiveSync(cont)
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

    func close(closeCode: Int = 1000, reason: String? = nil) async {
        let continuations = handleCloseSync()
        for cont in continuations {
            cont.resume(throwing: PyricBridgeError.unavailable("Closed"))
        }
    }

    func pushServerMessage(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return }
        lock.lock()
        defer { lock.unlock() }
        if !receiveContinuations.isEmpty {
            let cont = receiveContinuations.removeFirst()
            cont.resume(returning: str)
        } else {
            incomingQueue.append(str)
        }
    }

    private func findSentMessageSync(matching: ([String: AnySendable]) -> Bool) -> [String: AnySendable]? {
        lock.lock()
        defer { lock.unlock() }
        return sentMessages.first(where: matching)
    }

    func awaitSentMessage(
        matching: @escaping @Sendable ([String: AnySendable]) -> Bool,
        timeoutSeconds: Double = 3.0
    ) async throws -> [String: AnySendable] {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if let found = findSentMessageSync(matching: matching) {
                return found
            }
            try await Task.sleep(nanoseconds: 10_000_000) // 10ms poll
        }
        throw PyricBridgeError.deadlineExceeded("Timed out waiting for frame matching condition")
    }

    static func create() async throws -> (SnapshotStressHarness, Firestore) {
        let harness = SnapshotStressHarness()
        let client = PyricBridgeClient(channel: harness)
        let connectTask = Task { try await client.connect() }
        let attach = try await harness.awaitSentMessage { $0["type"]?.stringValue == "attach" }
        #expect(attach["type"]?.stringValue == "attach")
        harness.pushServerMessage([
            "type": "attach-ack",
            "protocol": 1,
            "bridgeVersion": "0.1.0",
            "peerConnected": true
        ])
        try await connectTask.value
        let db = Firestore(bridgeClient: client)
        return (harness, db)
    }
}

// ── Adversarial Test Suite ───────────────────────────────────────────────────

@Suite("Pyric Snapshot Stream Adversarial Stress Tests", .serialized)
struct SnapshotStreamAdversarialTests {

    private final class AtomicBox<T>: @unchecked Sendable {
        private let lock = NSLock()
        private var _value: T
        init(_ value: T) { self._value = value }
        var value: T {
            get { lock.lock(); defer { lock.unlock() }; return _value }
            set { lock.lock(); defer { lock.unlock() }; _value = newValue }
        }
        func mutate(_ block: (inout T) -> Void) {
            lock.lock()
            defer { lock.unlock() }
            block(&_value)
        }
        func waitFor(timeoutSeconds: Double = 3.0, condition: @escaping (T) -> Bool) async -> Bool {
            let deadline = Date().addingTimeInterval(timeoutSeconds)
            while Date() < deadline {
                if condition(value) { return true }
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
            return condition(value)
        }
    }

    // ─── 1. Ephemeral DocumentReference Retention ─────────────────────────────

    @Test("Ephemeral DocumentReference stays subscribed and receives multiple snapshot updates")
    func testEphemeralDocReferenceListener() async throws {
        let (harness, db) = try await SnapshotStressHarness.create()
        defer { Task { await harness.close() } }

        let receivedValues = AtomicBox<[Int]>([])

        // Helper function: creates DocumentReference within inner scope and returns ONLY the ListenerRegistration
        func attachEphemeral() -> ListenerRegistration {
            let doc = db.document("users/ephemeral_user")
            return doc.addSnapshotListener { snapshot, error in
                #expect(error == nil)
                if let raw = snapshot?.data()?["seq"],
                   let val = (raw as? Int64).map(Int.init) ?? (raw as? Int) {
                    receivedValues.mutate { $0.append(val) }
                }
            }
        }

        let registration = attachEphemeral()
        // Here `doc` is fully out of scope and deallocated

        let subMsg = try await harness.awaitSentMessage {
            $0["type"]?.stringValue == "worker-sub" &&
            $0["sub"]?.dictionaryValue?["target"]?.dictionaryValue?["path"]?.stringValue == "users/ephemeral_user"
        }
        let subId = try #require(subMsg["subId"]?.stringValue)

        // Deliver first snapshot
        harness.pushServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": [
                "id": "ephemeral_user",
                "path": "users/ephemeral_user",
                "exists": true,
                "data": ["json": "{\"seq\":1}"]
            ] as [String: Any]
        ])

        let got1 = await receivedValues.waitFor { $0 == [1] }
        #expect(got1 == true)

        // Deliver second snapshot
        harness.pushServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": [
                "id": "ephemeral_user",
                "path": "users/ephemeral_user",
                "exists": true,
                "data": ["json": "{\"seq\":2}"]
            ] as [String: Any]
        ])

        let got2 = await receivedValues.waitFor { $0 == [1, 2] }
        #expect(got2 == true)

        // Deliver third snapshot
        harness.pushServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": [
                "id": "ephemeral_user",
                "path": "users/ephemeral_user",
                "exists": true,
                "data": ["json": "{\"seq\":3}"]
            ] as [String: Any]
        ])

        let got3 = await receivedValues.waitFor { $0 == [1, 2, 3] }
        #expect(got3 == true)

        // Clean up
        registration.remove()
    }

    @Test("Ephemeral DocumentReference .snapshots AsyncSequence streams continuously")
    func testEphemeralDocReferenceAsyncSequence() async throws {
        let (harness, db) = try await SnapshotStressHarness.create()
        defer { Task { await harness.close() } }

        func getEphemeralStream() -> AsyncThrowingStream<DocumentSnapshot, Error> {
            let doc = db.document("users/stream_user")
            return doc.snapshots
        }

        let stream = getEphemeralStream()

        let consumerTask = Task<[Int], Error> {
            var results: [Int] = []
            for try await snap in stream {
                if let raw = snap.data()?["counter"],
                   let v = (raw as? Int64).map(Int.init) ?? (raw as? Int) {
                    results.append(v)
                    if results.count == 2 {
                        break
                    }
                }
            }
            return results
        }

        let subMsg = try await harness.awaitSentMessage {
            $0["type"]?.stringValue == "worker-sub" &&
            $0["sub"]?.dictionaryValue?["target"]?.dictionaryValue?["path"]?.stringValue == "users/stream_user"
        }
        let subId = try #require(subMsg["subId"]?.stringValue)

        // Yield snap 1
        harness.pushServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": [
                "id": "stream_user",
                "path": "users/stream_user",
                "exists": true,
                "data": ["json": "{\"counter\":100}"]
            ] as [String: Any]
        ])

        // Yield snap 2
        harness.pushServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": [
                "id": "stream_user",
                "path": "users/stream_user",
                "exists": true,
                "data": ["json": "{\"counter\":200}"]
            ] as [String: Any]
        ])

        let collected = try await consumerTask.value
        #expect(collected == [100, 200])
    }

    // ─── 2. Ephemeral Query Retention & DocumentChange Tracking ──────────────

    @Test("Ephemeral Query stays subscribed and computes DocumentChange diffs across snapshots")
    func testEphemeralQueryDocumentChanges() async throws {
        let (harness, db) = try await SnapshotStressHarness.create()
        defer { Task { await harness.close() } }

        struct QueryEvent: Sendable {
            let docCount: Int
            let addedCount: Int
            let modifiedCount: Int
        }

        let events = AtomicBox<[QueryEvent]>([])

        func attachEphemeralQuery() -> ListenerRegistration {
            let q = db.collection("orders").whereField("status", isEqualTo: "pending")
            return q.addSnapshotListener { snapshot, error in
                #expect(error == nil)
                guard let snapshot else { return }
                var added = 0
                var modified = 0
                for change in snapshot.documentChanges {
                    if change.type == .added { added += 1 }
                    if change.type == .modified { modified += 1 }
                }
                events.mutate {
                    $0.append(QueryEvent(
                        docCount: snapshot.documents.count,
                        addedCount: added,
                        modifiedCount: modified
                    ))
                }
            }
        }

        let registration = attachEphemeralQuery()
        // `q` is now out of scope

        let subMsg = try await harness.awaitSentMessage { msg in
            guard msg["type"]?.stringValue == "worker-sub" else { return false }
            let target = msg["sub"]?.dictionaryValue?["target"]?.dictionaryValue
            let p = target?["path"]?.stringValue ?? target?["source"]?.dictionaryValue?["path"]?.stringValue
            return p == "orders"
        }
        let subId = try #require(subMsg["subId"]?.stringValue)

        // Snapshot 1: Order 1 arrives (Initial add)
        harness.pushServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": [
                "docs": [
                    [
                        "id": "order1",
                        "path": "orders/order1",
                        "exists": true,
                        "data": ["json": "{\"status\":\"pending\",\"total\":50}"]
                    ] as [String: Any]
                ]
            ] as [String: Any]
        ])

        let got1 = await events.waitFor { $0.count == 1 }
        #expect(got1 == true)
        #expect(events.value.first?.docCount == 1)
        #expect(events.value.first?.addedCount == 1)
        #expect(events.value.first?.modifiedCount == 0)

        // Snapshot 2: Order 1 modified, Order 2 added
        harness.pushServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": [
                "docs": [
                    [
                        "id": "order1",
                        "path": "orders/order1",
                        "exists": true,
                        "data": ["json": "{\"status\":\"pending\",\"total\":75}"]
                    ] as [String: Any],
                    [
                        "id": "order2",
                        "path": "orders/order2",
                        "exists": true,
                        "data": ["json": "{\"status\":\"pending\",\"total\":120}"]
                    ] as [String: Any]
                ]
            ] as [String: Any]
        ])

        let got2 = await events.waitFor { $0.count == 2 }
        #expect(got2 == true)
        if events.value.count >= 2 {
            let secondEvent = events.value[1]
            #expect(secondEvent.docCount == 2)
            #expect(secondEvent.addedCount == 1)
            #expect(secondEvent.modifiedCount == 1)
        }

        registration.remove()
    }

    // ─── 3. includeMetadataChanges: true vs false ─────────────────────────────

    @Test("Verifies includeMetadataChanges flag propagation on wire and snapshot metadata")
    func testIncludeMetadataChangesWireAndSnapshot() async throws {
        let (harness, db) = try await SnapshotStressHarness.create()
        defer { Task { await harness.close() } }

        // Test with includeMetadataChanges: false (default)
        do {
            let doc = db.document("meta/false_test")
            let reg = doc.addSnapshotListener(includeMetadataChanges: false) { _, _ in }
            let subMsg = try await harness.awaitSentMessage {
                $0["type"]?.stringValue == "worker-sub" &&
                $0["sub"]?.dictionaryValue?["target"]?.dictionaryValue?["path"]?.stringValue == "meta/false_test"
            }
            let sub = try #require(subMsg["sub"]?.dictionaryValue)
            // On the wire, false is omitted to minimize payload
            #expect(sub["includeMetadataChanges"] == nil)
            reg.remove()
        }

        // Test with includeMetadataChanges: true
        do {
            let doc = db.document("meta/true_test")
            let receivedMeta = AtomicBox<SnapshotMetadata?>(nil)
            let reg = doc.addSnapshotListener(includeMetadataChanges: true) { snap, _ in
                receivedMeta.value = snap?.metadata
            }
            let subMsg = try await harness.awaitSentMessage {
                $0["type"]?.stringValue == "worker-sub" &&
                $0["sub"]?.dictionaryValue?["target"]?.dictionaryValue?["path"]?.stringValue == "meta/true_test"
            }
            let sub = try #require(subMsg["sub"]?.dictionaryValue)
            #expect(sub["includeMetadataChanges"]?.boolValue == true)
            let subId = try #require(subMsg["subId"]?.stringValue)

            // Deliver snapshot with metadata markers (using isFromCache as accepted by DocumentSnapshot.swift:129)
            harness.pushServerMessage([
                "type": "worker-snap",
                "subId": subId,
                "value": [
                    "id": "true_test",
                    "path": "meta/true_test",
                    "exists": true,
                    "hasPendingWrites": true,
                    "isFromCache": true,
                    "data": ["json": "{\"key\":\"val\"}"]
                ] as [String: Any]
            ])

            let gotMeta = await receivedMeta.waitFor { $0 != nil }
            #expect(gotMeta == true)
            let meta = try #require(receivedMeta.value)
            #expect(meta.hasPendingWrites == true)
            #expect(meta.isFromCache == true)

            reg.remove()
        }

        // Test with SnapshotListenOptions(includeMetadataChanges: true) on Query
        do {
            let q = db.collection("meta_col")
            let options = SnapshotListenOptions(includeMetadataChanges: true)
            let reg = q.addSnapshotListener(options: options) { _, _ in }
            let subMsg = try await harness.awaitSentMessage { msg in
                guard msg["type"]?.stringValue == "worker-sub" else { return false }
                let target = msg["sub"]?.dictionaryValue?["target"]?.dictionaryValue
                let p = target?["path"]?.stringValue ?? target?["source"]?.dictionaryValue?["path"]?.stringValue
                return p == "meta_col"
            }
            let sub = try #require(subMsg["sub"]?.dictionaryValue)
            #expect(sub["includeMetadataChanges"]?.boolValue == true)
            reg.remove()
        }
    }

    // ─── 4. Listener Unsubscription and Stream Termination ─────────────────

    @Test("registration.remove() terminates callback delivery immediately and frees task")
    func testListenerRemovalStopsCallbacks() async throws {
        let (harness, db) = try await SnapshotStressHarness.create()
        defer { Task { await harness.close() } }

        let callbackCount = AtomicBox<Int>(0)
        let doc = db.document("users/unsub_test")
        let reg = doc.addSnapshotListener { _, _ in
            callbackCount.mutate { $0 += 1 }
        }

        let subMsg = try await harness.awaitSentMessage {
            $0["type"]?.stringValue == "worker-sub" &&
            $0["sub"]?.dictionaryValue?["target"]?.dictionaryValue?["path"]?.stringValue == "users/unsub_test"
        }
        let subId = try #require(subMsg["subId"]?.stringValue)

        // First snap delivered
        harness.pushServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": [
                "id": "unsub_test",
                "path": "users/unsub_test",
                "exists": true,
                "data": ["json": "{\"x\":1}"]
            ] as [String: Any]
        ])

        let got1 = await callbackCount.waitFor { $0 == 1 }
        #expect(got1 == true)

        // Remove listener
        reg.remove()
        try await Task.sleep(nanoseconds: 20_000_000)

        // Second snap delivered after removal
        harness.pushServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": [
                "id": "unsub_test",
                "path": "users/unsub_test",
                "exists": true,
                "data": ["json": "{\"x\":2}"]
            ] as [String: Any]
        ])

        try await Task.sleep(nanoseconds: 50_000_000)
        // Count must remain 1 — callback was disconnected
        #expect(callbackCount.value == 1)
    }

    @Test("AsyncSequence consumer break and delayed unsubscription wake behavior (Bug A)")
    func testAsyncSequenceBreakTriggersUnsub() async throws {
        let (harness, db) = try await SnapshotStressHarness.create()
        defer { Task { await harness.close() } }

        let doc = db.document("users/break_test")

        let receivedCount = AtomicBox<Int>(0)
        let task = Task {
            for try await _ in doc.snapshots {
                receivedCount.mutate { $0 += 1 }
                break // Break after first snapshot
            }
        }

        let subMsg = try await harness.awaitSentMessage {
            $0["type"]?.stringValue == "worker-sub" &&
            $0["sub"]?.dictionaryValue?["target"]?.dictionaryValue?["path"]?.stringValue == "users/break_test"
        }
        let subId = try #require(subMsg["subId"]?.stringValue)

        // Deliver initial snap
        harness.pushServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": [
                "id": "break_test",
                "path": "users/break_test",
                "exists": true,
                "data": ["json": "{\"active\":true}"]
            ] as [String: Any]
        ])

        _ = try await task.value
        #expect(receivedCount.value == 1)

        // When the consumer task breaks out of `for try await _ in doc.snapshots`, the AsyncThrowingStream
        // is deallocated, triggering continuation.onTermination -> reg.remove() -> task.cancel().
        // As task terminates, Iterator.deinit runs cleanup(), sending worker-unsub to the bridge:
        let unsubMsg = try await harness.awaitSentMessage(matching: {
            $0["type"]?.stringValue == "worker-unsub" && $0["subId"]?.stringValue == subId
        }, timeoutSeconds: 2.0)
        #expect(unsubMsg["type"]?.stringValue == "worker-unsub")
    }

    // ─── 4b. Wire Metadata Deserialization & Query Snapshot Metadata (Bug B) ──

    @Test("Adversarially asserts DocumentSnapshot and QuerySnapshot metadata field handling (Bug B)")
    func testWireMetadataDiscrepancies() async throws {
        let (_, db) = try await SnapshotStressHarness.create()

        // 1. DocumentSnapshot parses "isFromCache", but ignores canonical Firestore wire field "fromCache"
        let wireWithCanonicalFromCache: [String: AnySendable] = [
            "id": .string("doc1"),
            "path": .string("col/doc1"),
            "exists": .bool(true),
            "fromCache": .bool(true),
            "hasPendingWrites": .bool(true),
            "data": .dictionary(["json": .string("{}")])
        ]
        let snap1 = DocumentSnapshot.fromWire(
            firestore: db,
            path: "col/doc1",
            wire: .dictionary(wireWithCanonicalFromCache)
        )
        // DocumentSnapshot.swift:129 reads wireDict["isFromCache"], so canonical "fromCache" evaluates to false:
        #expect(snap1.metadata.isFromCache == false)
        #expect(snap1.metadata.hasPendingWrites == true)

        // 2. QuerySnapshot hardcodes metadata to (hasPendingWrites: false, isFromCache: false)
        let queryWire: [String: AnySendable] = [
            "docs": .array([.dictionary(wireWithCanonicalFromCache)]),
            "fromCache": .bool(true),
            "hasPendingWrites": .bool(true)
        ]
        let qSnap = QuerySnapshot.fromWire(
            firestore: db,
            query: db.collection("col"),
            wire: .dictionary(queryWire)
        )
        // QuerySnapshot.swift:94 unconditionally hardcodes false for both
        #expect(qSnap.metadata.isFromCache == false)
        #expect(qSnap.metadata.hasPendingWrites == false)
    }

    // ─── 5. Dispatch Queue Routing & No Deadlocks ────────────────────────────

    @Test("Callbacks dispatch without deadlocks on macOS CLI default queue")
    func testDispatchDefaultQueueNoDeadlock() async throws {
        let (harness, db) = try await SnapshotStressHarness.create()
        defer { Task { await harness.close() } }

        #expect(db.settings.dispatchQueue === DispatchQueue.main)

        let invoked = AtomicBox<Bool>(false)
        let doc = db.document("test/deadlock_doc")
        let reg = doc.addSnapshotListener { snap, err in
            invoked.value = true
        }

        let subMsg = try await harness.awaitSentMessage {
            $0["type"]?.stringValue == "worker-sub" &&
            $0["sub"]?.dictionaryValue?["target"]?.dictionaryValue?["path"]?.stringValue == "test/deadlock_doc"
        }
        let subId = try #require(subMsg["subId"]?.stringValue)

        harness.pushServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": [
                "id": "deadlock_doc",
                "path": "test/deadlock_doc",
                "exists": true,
                "data": ["json": "{\"ok\":true}"]
            ] as [String: Any]
        ])

        let got = await invoked.waitFor { $0 == true }
        #expect(got == true)
        reg.remove()
    }

    @Test("Callbacks route onto custom background DispatchQueue without cross-thread deadlock")
    func testDispatchCustomBackgroundQueue() async throws {
        let (harness, db) = try await SnapshotStressHarness.create()
        defer { Task { await harness.close() } }

        let queueKey = DispatchSpecificKey<String>()
        let customQueue = DispatchQueue(label: "pyric.test.customBackgroundQueue")
        customQueue.setSpecific(key: queueKey, value: "custom-queue-active")
        db.settings.dispatchQueue = customQueue

        let verifiedOnCustomQueue = AtomicBox<Bool>(false)
        let doc = db.document("test/custom_queue_doc")
        let reg = doc.addSnapshotListener { snap, err in
            let marker = DispatchQueue.getSpecific(key: queueKey)
            if marker == "custom-queue-active" {
                verifiedOnCustomQueue.value = true
            }
        }

        let subMsg = try await harness.awaitSentMessage {
            $0["type"]?.stringValue == "worker-sub" &&
            $0["sub"]?.dictionaryValue?["target"]?.dictionaryValue?["path"]?.stringValue == "test/custom_queue_doc"
        }
        let subId = try #require(subMsg["subId"]?.stringValue)

        harness.pushServerMessage([
            "type": "worker-snap",
            "subId": subId,
            "value": [
                "id": "custom_queue_doc",
                "path": "test/custom_queue_doc",
                "exists": true,
                "data": ["json": "{\"routed\":true}"]
            ] as [String: Any]
        ])

        let got = await verifiedOnCustomQueue.waitFor { $0 == true }
        #expect(got == true)
        reg.remove()
    }

    @Test("Concurrent burst: 20 simultaneous snapshot listeners operate without races or deadlock")
    func testConcurrentListenerBurst() async throws {
        let (harness, db) = try await SnapshotStressHarness.create()
        defer { Task { await harness.close() } }

        let listenerCount = 20
        let completedDeliveries = AtomicBox<Int>(0)
        var registrations: [ListenerRegistration] = []

        for i in 0..<listenerCount {
            let doc = db.document("burst/doc_\(i)")
            let reg = doc.addSnapshotListener { snap, err in
                #expect(err == nil)
                completedDeliveries.mutate { $0 += 1 }
            }
            registrations.append(reg)
        }

        // Collect all 20 worker-sub messages
        var subIds: [String] = []
        for i in 0..<listenerCount {
            let msg = try await harness.awaitSentMessage(matching: {
                $0["type"]?.stringValue == "worker-sub" &&
                $0["sub"]?.dictionaryValue?["target"]?.dictionaryValue?["path"]?.stringValue == "burst/doc_\(i)"
            }, timeoutSeconds: 3.0)
            if let id = msg["subId"]?.stringValue {
                subIds.append(id)
            }
        }
        #expect(subIds.count == listenerCount)

        // Dispatch snapshot to all 20 simultaneously
        for id in subIds {
            harness.pushServerMessage([
                "type": "worker-snap",
                "subId": id,
                "value": [
                    "id": "any",
                    "path": "burst/any",
                    "exists": true,
                    "data": ["json": "{\"burst\":true}"]
                ] as [String: Any]
            ])
        }

        let allDone = await completedDeliveries.waitFor { $0 == listenerCount }
        #expect(allDone == true)

        // Remove all listeners
        for reg in registrations {
            reg.remove()
        }
    }
}
