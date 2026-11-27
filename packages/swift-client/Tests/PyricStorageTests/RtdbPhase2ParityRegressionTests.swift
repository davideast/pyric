import Foundation
import Testing
import FirebaseAuth
import PyricDatabase
import PyricFirestore

private final class MutableTestAuthProvider: AuthCredentialProvider, @unchecked Sendable {
    private let lock = NSLock()
    private var lens: AuthLens = .anon
    private var continuations: [UUID: AsyncStream<AuthLens>.Continuation] = [:]

    func currentAuthLens() -> AuthLens {
        lock.lock()
        defer { lock.unlock() }
        return lens
    }

    var authLensStream: AsyncStream<AuthLens> {
        AsyncStream { continuation in
            let id = UUID()
            lock.lock()
            continuations[id] = continuation
            continuation.yield(lens)
            lock.unlock()
            continuation.onTermination = { [weak self] _ in
                self?.lock.lock()
                self?.continuations.removeValue(forKey: id)
                self?.lock.unlock()
            }
        }
    }

    func getIDToken(forcingRefresh: Bool) async throws -> String? { nil }

    func setLens(_ next: AuthLens) {
        lock.lock()
        lens = next
        let snapshot = Array(continuations.values)
        lock.unlock()
        for c in snapshot { c.yield(next) }
    }
}

private final class ValueCollector<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [T] = []
    func append(_ v: T) {
        lock.lock()
        items.append(v)
        lock.unlock()
    }
    var values: [T] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }
}

@Suite("RTDB Phase 2 Parity Regression Suite", .serialized)
struct RtdbPhase2ParityRegressionTests {
    private func makeConnectedDatabase(
        name: String,
        handler: @escaping @Sendable ([String: AnySendable], MockStorageBridgeChannel) -> Void
    ) async throws -> (FirebaseApp, PyricBridgeClient, Database, MockStorageBridgeChannel) {
        let app = FirebaseApp(
            name: name,
            options: FirebaseOptions(projectID: "rtdb-p2-swift", apiKey: "key", googleAppID: "1:1:ios:abc")
        )
        let channel = MockStorageBridgeChannel { frame, ch in
            if frame["type"]?.stringValue == "attach" {
                ch.sendFromServer([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "sandboxConnected": true,
                    "clientSessionId": "sess-\(name)",
                ])
                return
            }
            handler(frame, ch)
        }
        let client = PyricBridgeClient(
            endpoint: URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!,
            transportFactory: { _ in channel }
        )
        let db = Database(app: app, url: "https://rtdb-p2-swift-default-rtdb.firebaseio.com", bridgeClient: client)
        try await client.connect()
        return (app, client, db, channel)
    }

    @Test("P2-S11a & P2-F12: clears latestSnapshot across lens switch and recovers after permission-denied")
    func clearsLatestSnapshotAndRecoversFromDenial() async throws {
        let subIDs = ValueCollector<String>()
        let (_, client, db, channel) = try await makeConnectedDatabase(name: "rtdb-s11a") { frame, _ in
            if frame["type"]?.stringValue == "worker-sub",
               let subId = frame["subId"]?.stringValue {
                subIDs.append(subId)
            }
        }

        db.switchLens(.asUser(uid: "alice"))
        let aliceVals = ValueCollector<String>()
        let cancelCount = ValueCollector<Int>()
        let ref = db.reference(withPath: "secrets/item")
        let hA = ref.observe(.value, with: { snap in
            if let s = snap.value as? String { aliceVals.append(s) }
        }, withCancel: { _ in
            cancelCount.append(1)
        })

        for _ in 0..<40 where subIDs.values.isEmpty {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let firstSub = try #require(subIDs.values.first)
        channel.sendFromServer([
            "type": "worker-snap",
            "subId": firstSub,
            "value": ["key": "item", "exists": true, "value": "ALICE_SECRET"],
        ])
        for _ in 0..<40 where aliceVals.values.isEmpty {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(aliceVals.values == ["ALICE_SECRET"])

        db.switchLens(.asUser(uid: "bob"))
        let bobVals = ValueCollector<String>()
        let hB = ref.observe(.value) { snap in
            if let s = snap.value as? String { bobVals.append(s) }
        }
        try await Task.sleep(nanoseconds: 40_000_000)
        #expect(bobVals.values.isEmpty)

        for _ in 0..<40 where subIDs.values.count < 2 {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let secondSub = subIDs.values[1]
        channel.sendFromServer([
            "type": "worker-snap",
            "subId": secondSub,
            "value": ["__error": ["code": "PERMISSION_DENIED", "message": "denied"]],
        ])
        for _ in 0..<40 where cancelCount.values.isEmpty {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(cancelCount.values.count == 1)

        db.switchLens(.asUser(uid: "alice"))
        for _ in 0..<40 where subIDs.values.count < 3 {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let thirdSub = subIDs.values[2]
        channel.sendFromServer([
            "type": "worker-snap",
            "subId": thirdSub,
            "value": ["key": "item", "exists": true, "value": "RECOVERED"],
        ])
        for _ in 0..<40 where !aliceVals.values.contains("RECOVERED") {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(aliceVals.values.contains("RECOVERED"))

        ref.removeObserver(withHandle: hA)
        ref.removeObserver(withHandle: hB)
        await client.disconnect()
    }

    @Test("P2-S11b: observeSingleEvent waits for childAdded and childChanged then detaches")
    func observeSingleEventChildTypes() async throws {
        let subIDs = ValueCollector<String>()
        let unsubIDs = ValueCollector<String>()
        let (_, client, db, channel) = try await makeConnectedDatabase(name: "rtdb-s11b") { frame, _ in
            if frame["type"]?.stringValue == "worker-sub",
               let subId = frame["subId"]?.stringValue {
                subIDs.append(subId)
            } else if frame["type"]?.stringValue == "worker-unsub",
                      let subId = frame["subId"]?.stringValue {
                unsubIDs.append(subId)
            }
        }

        let ref = db.reference(withPath: "rooms/chat")
        let task = Task { try await ref.observeSingleEvent(of: .childChanged) }
        for _ in 0..<40 where subIDs.values.isEmpty {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let subId = try #require(subIDs.values.first)
        channel.sendFromServer([
            "type": "worker-snap",
            "subId": subId,
            "value": ["key": "chat", "exists": true, "value": ["m1": "hello"]],
        ])
        try await Task.sleep(nanoseconds: 25_000_000)
        channel.sendFromServer([
            "type": "worker-snap",
            "subId": subId,
            "value": ["key": "chat", "exists": true, "value": ["m1": "edited"]],
        ])
        let changed = try await task.value
        #expect(changed.key == "m1")
        #expect(changed.value as? String == "edited")
        for _ in 0..<40 where unsubIDs.values.isEmpty {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(unsubIDs.values.contains(subId))
        await client.disconnect()
    }

    @Test("P2-S11c & txLens pinning: MutableData persists child priority and transaction pins lens")
    func mutableDataChildPriorityAndPinnedTransaction() async throws {
        let md = MutableData(key: "root", value: ["a": 1])
        md.childData(byAppendingPath: "a").priority = 5.0
        #expect(md.childData(byAppendingPath: "a").priority as? Double == 5.0)
        #expect(md.childData(byAppendingPath: "a").value as? Int == 1)

        let actAsUids = ValueCollector<String>()
        let commitPayloads = ValueCollector<AnySendable>()
        let (_, client, db, _) = try await makeConnectedDatabase(name: "rtdb-s11c") { frame, ch in
            guard frame["type"]?.stringValue == "worker-op",
                  let id = frame["id"]?.stringValue,
                  let op = frame["op"]?.dictionaryValue,
                  let method = op["method"]?.stringValue else { return }
            if let uid = op["actAs"]?["uid"]?.stringValue {
                actAsUids.append(uid)
            }
            if method == "rtdb.get" {
                ch.sendFromServer([
                    "type": "worker-res",
                    "id": id,
                    "ok": true,
                    "value": ["key": "node", "exists": true, "value": ["a": 1]],
                ])
            } else if method == "rtdb.transactionCommit" {
                if let v = op["params"]?["value"] ?? op["value"] {
                    commitPayloads.append(v)
                }
                ch.sendFromServer([
                    "type": "worker-res",
                    "id": id,
                    "ok": true,
                    "value": ["committed": false, "retry": false],
                ])
            }
        }

        db.switchLens(.asUser(uid: "alice"))
        let res = try await db.reference(withPath: "tx/node").runTransactionBlock { current in
            db.switchLens(.asUser(uid: "bob"))
            current.childData(byAppendingPath: "a").value = 2
            current.childData(byAppendingPath: "a").priority = 7.0
            return .success(withValue: current)
        }
        #expect(res.committed == false)
        let snapDict = res.snapshot.value as? [String: Any]
        #expect((snapDict?["a"] as? Int64) == 1 || (snapDict?["a"] as? Int) == 1)
        #expect(actAsUids.values == ["alice", "alice"])
        let sent = try #require(commitPayloads.values.first)
        #expect(sent["a"]?[".priority"]?.doubleValue == 7.0)
        await client.disconnect()
    }

    @Test("P2-S11d: AuthCredentialProviderRegistry reset allows re-bootstrap and lazy authLensStream forwards transitions")
    func authBootstrapResetAndLazyLensStream() async throws {
        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            defer { FirebaseAuthBootstrap.initialize() }
            AuthCredentialProviderRegistry.reset()
            #expect(!AuthCredentialProviderRegistry.hasFactory)
            FirebaseAuthBootstrap.initialize()
            #expect(AuthCredentialProviderRegistry.hasFactory)

            AuthCredentialProviderRegistry.reset()
            let app = FirebaseApp(
                name: "lazy-lens-app-\(UUID().uuidString)",
                options: FirebaseOptions(projectID: "lazy-proj", apiKey: "key", googleAppID: "1:1:ios:xyz")
            )
            let dummyChannel = MockStorageBridgeChannel()
            let client = PyricBridgeClient(
                endpoint: URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!,
                transportFactory: { _ in dummyChannel }
            )
            let firestore = Firestore(bridgeClient: client, app: app)
            let db = Database(app: app, url: "https://lazy-proj-default-rtdb.firebaseio.com", bridgeClient: client)

            let fsLenses = ValueCollector<AuthLens>()
            let dbLenses = ValueCollector<AuthLens>()
            let fsTask = Task {
                for await lens in firestore.authLensStream {
                    fsLenses.append(lens)
                    if case .asUser(let uid, _, _) = lens, uid == "alice" { break }
                }
            }
            let dbTask = Task {
                for await lens in db.authLensStream {
                    dbLenses.append(lens)
                    if case .asUser(let uid, _, _) = lens, uid == "alice" { break }
                }
            }
            try await Task.sleep(nanoseconds: 25_000_000)

            let provider = MutableTestAuthProvider()
            AuthCredentialProviderRegistry.register(app: app, provider: provider)
            provider.setLens(.asUser(uid: "alice"))

            for _ in 0..<50 {
                let fsDone = fsLenses.values.contains(.asUser(uid: "alice"))
                let dbDone = dbLenses.values.contains(.asUser(uid: "alice"))
                if fsDone && dbDone { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            fsTask.cancel()
            dbTask.cancel()
            #expect(fsLenses.values.contains(.asUser(uid: "alice")))
            #expect(dbLenses.values.contains(.asUser(uid: "alice")))
        }
    }
}
