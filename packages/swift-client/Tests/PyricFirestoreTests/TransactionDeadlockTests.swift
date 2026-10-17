import Foundation
import Testing
@testable import PyricFirestore

// Completion-form transactions read through the synchronous
// `Transaction.getDocument(_:error:)`, which blocks its thread until the read's
// reply arrives. Run on the Swift concurrency cooperative pool, enough of them at
// once blocked every pool thread and nothing could process the replies, so no
// transaction settled. The waits below block a thread on purpose: an async wait
// would itself need a free pool thread, and a deadlock would hang the run instead
// of failing it. Each wait holds one pool thread while it lasts, so the suite is
// serialized: run in parallel, its four waits alone would hold every thread of a
// three-core runner's pool.

/// How long a test waits for its transactions to settle before it reports a deadlock.
/// The fixed code settles in milliseconds; this only bounds the failure.
private let settleTimeout: DispatchTimeInterval = .seconds(30)

/// More concurrent transactions than the cooperative pool has threads.
private let width = ProcessInfo.processInfo.activeProcessorCount + 4

/// A bridge host that answers every `worker-op` as soon as it is sent:
/// `getDoc` with a missing document, anything else with null. `failsReads` answers
/// every `getDoc` with permission-denied; `abortsFirstCommit` answers the first
/// `txnCommit` with aborted.
private final class AnsweringHost: @unchecked Sendable {
    private let lock = NSLock()
    private var _methods: [String] = []
    private let failsReads: Bool
    private let abortsFirstCommit: Bool

    init(failsReads: Bool = false, abortsFirstCommit: Bool = false) {
        self.failsReads = failsReads
        self.abortsFirstCommit = abortsFirstCommit
    }

    /// The `worker-op` methods sent, in the order the host received them.
    var methods: [String] {
        lock.lock(); defer { lock.unlock() }
        return _methods
    }

    func count(of method: String) -> Int {
        methods.filter { $0 == method }.count
    }

    func connect(_ request: URLRequest) async throws -> any WebSocketTransport {
        FakeReconnectSocket { [self] frame, socket in self.answer(frame, on: socket) }
    }

    private func answer(_ frame: [String: AnySendable], on socket: FakeReconnectSocket) {
        switch frame["type"]?.stringValue {
        case "attach":
            socket.deliver([
                "type": "attach-ack",
                "protocol": 1,
                "peerConnected": true,
                "clientSessionId": frame["clientSessionId"]?.stringValue ?? "session-1",
                "hostInstanceId": "host-a",
            ])
        case "worker-op":
            answerOp(frame, on: socket)
        default:
            break
        }
    }

    /// Records the method and returns whether it is the first `txnCommit`.
    private func record(_ method: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        _methods.append(method)
        return method == "txnCommit" && _methods.filter { $0 == "txnCommit" }.count == 1
    }

    private func answerOp(_ frame: [String: AnySendable], on socket: FakeReconnectSocket) {
        guard let id = frame["id"]?.stringValue, let op = frame["op"] else { return }
        let method = op["method"]?.stringValue ?? "?"
        let isFirstCommit = record(method)
        let refusesRead = method == "getDoc" && failsReads
        if refusesRead {
            refuse(id, code: "permission-denied", on: socket)
            return
        }
        if isFirstCommit && abortsFirstCommit {
            refuse(id, code: "aborted", on: socket)
            return
        }
        let value: Any = method == "getDoc" ? ["path": op["path"]?.stringValue ?? "", "exists": false] : NSNull()
        socket.deliver(["type": "worker-res", "id": id, "ok": true, "value": value])
    }

    private func refuse(_ id: String, code: String, on socket: FakeReconnectSocket) {
        socket.deliver([
            "type": "worker-res",
            "id": id,
            "ok": false,
            "error": ["code": code, "message": "Refused by the test host."],
        ])
    }
}

/// Collects settled transactions and wakes a blocked waiter when all have settled.
private final class Settlements: @unchecked Sendable {
    private let lock = NSLock()
    private let allSettled = DispatchSemaphore(value: 0)
    private let expected: Int
    private var _errors: [Error?] = []

    init(expected: Int) {
        self.expected = expected
    }

    /// Each settled transaction's error, nil for a success, in settle order.
    var errors: [Error?] {
        lock.lock(); defer { lock.unlock() }
        return _errors
    }

    func settle(_ error: Error?) {
        lock.lock()
        _errors.append(error)
        let complete = _errors.count == expected
        lock.unlock()
        if complete { allSettled.signal() }
    }

    /// Blocks this thread until every transaction settles or the timeout passes.
    func waitForAll() -> Bool {
        allSettled.wait(timeout: .now() + settleTimeout) == .success
    }
}

private func connectedFirestore(_ host: AnsweringHost) async throws -> Firestore {
    let client = PyricBridgeClient(
        retryInitialConnection: false,
        reconnectDelay: { _ in 0 },
        attachTimeout: 5,
        transportFactory: { request in try await host.connect(request) }
    )
    try await client.connect()
    let db = Firestore(bridgeClient: client, app: FirebaseApp(name: "txn-deadlock-\(UUID().uuidString)"))
    db.settings.dispatchQueue = DispatchQueue(label: "txn-deadlock-callbacks")
    return db
}

@Suite("Completion-form transactions off the cooperative pool", .serialized)
struct TransactionDeadlockTests {

    @Test("More concurrent completion-form transactions than cooperative threads all read and settle")
    func concurrentTransactionsSettle() async throws {
        let host = AnsweringHost()
        let db = try await connectedFirestore(host)
        let settlements = Settlements(expected: width)

        for n in 0..<width {
            let doc = db.document("txn-deadlock/\(n)")
            db.runTransaction({ txn, errorPointer in
                _ = txn.getDocument(doc, error: errorPointer)
                txn.setData(["n": n], forDocument: doc)
                return n
            }, completion: { _, error in settlements.settle(error) })
        }

        let settled = settlements.waitForAll()
        #expect(settled, "\(settlements.errors.count) of \(width) transactions settled, \(host.count(of: "getDoc")) reads sent")
        #expect(settlements.errors.count == width)
        #expect(settlements.errors.allSatisfy { $0 == nil })
        #expect(host.count(of: "getDoc") == width)
        #expect(host.count(of: "txnCommit") == width)
    }

    @Test("A completion-form transaction returns its block's value and sends its read before its commit")
    func returnsBlockValue() async throws {
        let host = AnsweringHost()
        let db = try await connectedFirestore(host)
        let doc = db.document("txn-deadlock/value")
        let values = Collected<String>()
        let settlements = Settlements(expected: 1)

        db.runTransaction({ txn, errorPointer in
            let snapshot = txn.getDocument(doc, error: errorPointer)
            return snapshot?.exists == false ? "missing" : "unexpected"
        }, completion: { value, error in
            values.append(value as? String ?? "nil")
            settlements.settle(error)
        })

        #expect(settlements.waitForAll())
        #expect(values.all == ["missing"])
        #expect(settlements.errors.count == 1 && settlements.errors[0] == nil)
        #expect(host.methods == ["getDoc", "txnCommit"])
    }

    @Test("A read error reaches the block's error pointer, and the block's error fails the transaction without a commit")
    func readErrorReachesBlockAndCompletion() async throws {
        let host = AnsweringHost(failsReads: true)
        let db = try await connectedFirestore(host)
        let doc = db.document("txn-deadlock/denied")
        let readOutcomes = Collected<String>()
        let settlements = Settlements(expected: 1)

        db.runTransaction({ txn, errorPointer in
            let snapshot = txn.getDocument(doc, error: errorPointer)
            let reportedError = snapshot == nil && errorPointer?.pointee != nil
            readOutcomes.append(reportedError ? "error" : "no error")
            return nil
        }, completion: { _, error in settlements.settle(error) })

        #expect(settlements.waitForAll())
        #expect(readOutcomes.all == ["error"])
        #expect(settlements.errors.count == 1 && settlements.errors[0] != nil)
        #expect(host.methods == ["getDoc"])
    }

    @Test("An aborted commit runs the block again and the retry settles the transaction")
    func abortedCommitRetries() async throws {
        let host = AnsweringHost(abortsFirstCommit: true)
        let db = try await connectedFirestore(host)
        let doc = db.document("txn-deadlock/retry")
        let runs = Collected<Int>()
        let settlements = Settlements(expected: 1)

        db.runTransaction({ txn, errorPointer in
            _ = txn.getDocument(doc, error: errorPointer)
            txn.setData(["retried": true], forDocument: doc)
            runs.append(1)
            return nil
        }, completion: { _, error in settlements.settle(error) })

        #expect(settlements.waitForAll())
        #expect(runs.count == 2)
        #expect(settlements.errors.count == 1 && settlements.errors[0] == nil)
        #expect(host.methods == ["getDoc", "txnCommit", "getDoc", "txnCommit"])
    }
}
