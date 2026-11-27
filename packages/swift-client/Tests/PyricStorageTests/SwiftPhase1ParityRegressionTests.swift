import Foundation
import Testing
import FirebaseAuth
@testable import PyricFirestore
@testable import PyricStorage

@Suite("Swift Phase 1 Parity Regression Suite", .serialized)
struct SwiftPhase1ParityRegressionTests {

    private final class OpRecorder<T: Sendable>: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [T] = []

        func record(_ item: T) {
            lock.lock()
            items.append(item)
            lock.unlock()
        }

        func snapshot() -> [T] {
            lock.lock()
            defer { lock.unlock() }
            return items
        }
    }

    private final class MutableAuthProvider: AuthCredentialProvider, @unchecked Sendable {
        private let lock = NSLock()
        private var lens: AuthLens = .anon

        func setLens(_ next: AuthLens) {
            lock.lock()
            lens = next
            lock.unlock()
        }

        func currentAuthLens() -> AuthLens {
            lock.lock()
            defer { lock.unlock() }
            return lens
        }

        var authLensStream: AsyncStream<AuthLens> {
            let current = currentAuthLens()
            return AsyncStream { cont in
                cont.yield(current)
            }
        }
    }

    private enum MockOpReply: Sendable {
        case success(AnySendable)
        case failure(String, String)
    }

    private func makeMockChannel(
        onOp: @escaping @Sendable ([String: AnySendable]) -> MockOpReply
    ) -> MockStorageBridgeChannel {
        MockStorageBridgeChannel { frame, chan in
            if frame["type"]?.stringValue == "attach" {
                chan.sendFromServer([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "sandboxConnected": true,
                    "clientSessionId": "sess-parity",
                ])
                return
            }
            guard frame["type"]?.stringValue == "worker-op",
                  let id = frame["id"]?.stringValue,
                  let op = frame["op"]?.dictionaryValue else { return }
            switch onOp(op) {
            case .success(let value):
                chan.sendFromServer([
                    "type": "worker-res",
                    "id": id,
                    "ok": true,
                    "value": value.toAny(),
                ])
            case .failure(let code, let message):
                chan.sendFromServer([
                    "type": "worker-res",
                    "id": id,
                    "ok": false,
                    "error": [
                        "code": code,
                        "message": message,
                    ],
                ])
            }
        }
    }

    @Test("P2-S01: AggregateQuery.getAggregation rejects when network is disabled or terminated")
    func aggregateQueryRespectsOfflineAndTerminate() async throws {
        let recorder = OpRecorder<String>()
        let channel = makeMockChannel { op in
            recorder.record(op["method"]?.stringValue ?? "")
            return .success(.int(99))
        }
        let client = PyricBridgeClient(channel: channel)
        let app = FirebaseApp(
            name: "s01-app-\(UUID().uuidString)",
            options: FirebaseOptions(projectID: "demo-s01", apiKey: "k", googleAppID: "1:1:ios:s01")
        )
        let db = Firestore(bridgeClient: client, app: app)

        try await db.disableNetwork()
        do {
            _ = try await db.collection("items").count.getAggregation(source: .server)
            Issue.record("Expected unavailable error while offline")
        } catch let err as PyricBridgeError {
            #expect(err.code == .unavailable)
        }
        #expect(recorder.snapshot().isEmpty)

        try await db.enableNetwork()
        try await db.terminate()
        do {
            _ = try await db.collection("items").count.getAggregation(source: .server)
            Issue.record("Expected failedPrecondition error after terminate")
        } catch let err as PyricBridgeError {
            #expect(err.code == .failedPrecondition)
        }
        await client.disconnect()
    }

    @Test("P2-S02 & P2-S03: Source.cache, offline projections, enableNetwork replay, and waitForPendingWrites are auth-scoped")
    func offlineCacheAndReplayAreAuthScoped() async throws {
        let sentOps = OpRecorder<[String: AnySendable]>()
        let channel = makeMockChannel { op in
            sentOps.record(op)
            if op["method"]?.stringValue == "getDoc" {
                return .success(.dictionary([
                    "exists": .bool(true),
                    "data": .dictionary(["secret": .string("alice-only")]),
                ]))
            }
            return .success(.null)
        }
        let client = PyricBridgeClient(channel: channel)
        let app = FirebaseApp(
            name: "s02-app-\(UUID().uuidString)",
            options: FirebaseOptions(projectID: "demo-s02", apiKey: "k", googleAppID: "1:1:ios:s02")
        )
        let db = Firestore(bridgeClient: client, app: app)
        let authProvider = MutableAuthProvider()
        db.credentialProvider = authProvider
        let docRef = db.collection("secrets").document("doc1")

        authProvider.setLens(.asUser(uid: "alice"))
        let aliceSnap = try await docRef.getDocument(source: .server)
        #expect(aliceSnap.data()?["secret"] as? String == "alice-only")

        // Same user can read from cache.
        let aliceCached = try await docRef.getDocument(source: .cache)
        #expect(aliceCached.data()?["secret"] as? String == "alice-only")

        // Different tenant or different user must NOT see Alice's cached document.
        authProvider.setLens(.asUser(uid: "alice", tenant: "tenant-b"))
        do {
            _ = try await docRef.getDocument(source: .cache)
            Issue.record("Expected cache miss across tenant boundary")
        } catch let err as PyricBridgeError {
            #expect(err.code == .unavailable)
        }

        authProvider.setLens(.asUser(uid: "alice"))
        try await db.disableNetwork()
        let aliceWriteTask = Task {
            try await docRef.setData(["secret": "alice-offline"])
        }
        // Wait briefly for write to stage offline.
        try await Task.sleep(nanoseconds: 50_000_000)

        // Switch to Bob while still offline: Bob must not see Alice's staged write,
        // and Bob's waitForPendingWrites must not block on Alice's write.
        authProvider.setLens(.asUser(uid: "bob"))
        do {
            _ = try await docRef.getDocument(source: .cache)
            Issue.record("Expected cache miss for Bob while Alice has staged offline write")
        } catch let err as PyricBridgeError {
            #expect(err.code == .unavailable)
        }
        try await db.waitForPendingWrites()

        // Re-enabling network as Bob must abort Alice's staged write without sending it.
        let opsBeforeEnable = sentOps.snapshot().count
        try await db.enableNetwork()
        do {
            try await aliceWriteTask.value
            Issue.record("Expected Alice's staged offline write to abort on cross-user reconnect")
        } catch let err as PyricBridgeError {
            #expect(err.code == .aborted)
        }
        #expect(sentOps.snapshot().count == opsBeforeEnable)
        await client.disconnect()
    }

    @Test("P2-S04: Transaction re-checks disableNetwork mid-transaction before getDocument and txnCommit")
    func transactionChecksOfflineMidFlight() async throws {
        let sentMethods = OpRecorder<String>()
        let channel = makeMockChannel { op in
            sentMethods.record(op["method"]?.stringValue ?? "")
            return .success(.dictionary(["exists": .bool(true), "data": .dictionary(["v": .int(1)])]))
        }
        let client = PyricBridgeClient(channel: channel)
        let app = FirebaseApp(
            name: "s04-app-\(UUID().uuidString)",
            options: FirebaseOptions(projectID: "demo-s04", apiKey: "k", googleAppID: "1:1:ios:s04")
        )
        let db = Firestore(bridgeClient: client, app: app)
        let docRef = db.collection("counters").document("c1")

        do {
            _ = try await db.runTransaction { txn in
                try await db.disableNetwork()
                _ = try await txn.getDocument(docRef)
                return nil
            }
            Issue.record("Expected unavailable error when going offline before txn.getDocument")
        } catch let err as PyricBridgeError {
            #expect(err.code == .unavailable)
        }
        #expect(!sentMethods.snapshot().contains("getDoc"))

        try await db.enableNetwork()
        do {
            _ = try await db.runTransaction { txn in
                txn.setData(["v": 2], forDocument: docRef)
                try await db.disableNetwork()
                return nil
            }
            Issue.record("Expected unavailable error when going offline before txnCommit")
        } catch let err as PyricBridgeError {
            #expect(err.code == .unavailable)
        }
        #expect(!sentMethods.snapshot().contains("txnCommit"))
        await client.disconnect()
    }

    @Test("P2-S05: Storage updateMetadata prefers client-plane storage.updateMetadata under caller lens")
    func storageUpdateMetadataUsesClientPlaneOp() async throws {
        let recordedOps = OpRecorder<[String: AnySendable]>()
        let channel = makeMockChannel { op in
            recordedOps.record(op)
            if op["method"]?.stringValue == "storage.updateMetadata" {
                return .success(.dictionary([
                    "bucket": .string("demo-s05.appspot.com"),
                    "fullPath": .string("docs/a.txt"),
                    "name": .string("a.txt"),
                    "size": .int(12),
                    "generation": .string("1"),
                    "metageneration": .string("2"),
                    "cacheControl": .string("no-store"),
                    "customMetadata": .dictionary(["env": .string("prod")]),
                ]))
            }
            return .failure("internal", "unexpected fallback method")
        }
        let client = PyricBridgeClient(channel: channel)
        let app = FirebaseApp(
            name: "s05-app-\(UUID().uuidString)",
            options: FirebaseOptions(
                projectID: "demo-s05",
                apiKey: "k",
                googleAppID: "1:1:ios:s05",
                storageBucket: "demo-s05.appspot.com"
            )
        )
        let storage = Storage.storage(app: app, bridgeClient: client)
        storage.switchLens(.asUser(uid: "alice"))
        let patch = StorageMetadata()
        patch.cacheControl = "no-store"
        patch.customMetadata = ["env": "prod"]

        let updated = try await storage.reference(withPath: "docs/a.txt").updateMetadata(patch)
        #expect(updated.metageneration == 2)
        #expect(updated.cacheControl == "no-store")
        #expect(updated.customMetadata?["env"] == "prod")

        let ops = recordedOps.snapshot()
        #expect(ops.count == 1)
        #expect(ops[0]["method"]?.stringValue == "storage.updateMetadata")
        #expect(ops[0]["replaceCustomMetadata"]?.boolValue == true)
        #expect(ops[0]["actAs"]?["mode"]?.stringValue == "as")
        #expect(ops[0]["actAs"]?["uid"]?.stringValue == "alice")
        await client.disconnect()
    }

    @Test("P2-S06 & P2-S14: Error hygiene hides denialContext, parses Auth blocking JSON, and escapes backtick/backslash FieldPaths")
    func errorHygieneAndUpdateDataSegmentEscaping() async throws {
        let traceError = PyricBridgeError(
            code: .permissionDenied,
            rawCode: "permission-denied",
            message: "Missing or insufficient permissions.",
            denialContext: .dictionary(["expressionTrace": .string("SECRET_TRACE_PAYLOAD")])
        )
        #expect(!traceError.description.contains("SECRET_TRACE_PAYLOAD"))
        #expect(!traceError.description.contains("denialContext"))
        #expect(traceError.denialContext != nil)

        let storageErr = StorageErrorCode.from(traceError)
        #expect(!(storageErr.underlyingDescription?.contains("SECRET_TRACE_PAYLOAD") ?? false))

        let blockingRaw = PyricBridgeError(
            code: .internalError,
            rawCode: "internal",
            message: "HTTP 403: {\"error\":{\"code\":403,\"message\":\"Domain not allowed\",\"status\":\"PERMISSION_DENIED\"}}"
        )
        let authErr = AuthError.from(error: blockingRaw)
        #expect(authErr.code == .permissionDenied)
        #expect(authErr.message == "Domain not allowed")
        #expect(AuthErrorCode.from(error: blockingRaw) == .permissionDenied)

        let recordedOps = OpRecorder<[String: AnySendable]>()
        let channel = makeMockChannel { op in
            recordedOps.record(op)
            return .success(.null)
        }
        let client = PyricBridgeClient(channel: channel)
        let app = FirebaseApp(
            name: "s14-app-\(UUID().uuidString)",
            options: FirebaseOptions(projectID: "demo-s14", apiKey: "k", googleAppID: "1:1:ios:s14")
        )
        let db = Firestore(bridgeClient: client, app: app)
        try await db.collection("docs").document("d1").updateData([
            FieldPath(["a`b", "c\\d"]): "val"
        ])
        let updateOp = try #require(recordedOps.snapshot().first)
        #expect(updateOp["fields"]?.arrayValue != nil)
        await client.disconnect()
    }
}
