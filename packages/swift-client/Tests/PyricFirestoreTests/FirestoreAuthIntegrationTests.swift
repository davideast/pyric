import Foundation
import Testing
@testable import PyricFirestore
@testable import FirebaseAuth

@Suite("Firestore & FirebaseAuth Integration Suite")
struct FirestoreAuthIntegrationTests {

    private func createHarness(appName: String = "IntegrationApp-\(UUID().uuidString)") async throws -> (ConformanceMockHarness, Firestore, Auth) {
        let harness = ConformanceMockHarness()
        let client = PyricBridgeClient(channel: harness)
        try await client.connect()

        let app = FirebaseApp(name: appName)
        let firestore = Firestore(bridgeClient: client, app: app)
        let auth = Auth(app: app, bridgeClient: client)
        AuthCredentialProviderRegistry.register(app: app, provider: auth)

        return (harness, firestore, auth)
    }

    // ── 1. Unauthenticated Operations Stamp .anon ────────────────────────────

    @Test("Unauthenticated Firestore reads, writes, and queries stamp actAs: anon")
    func testUnauthenticatedOperationsStampAnon() async throws {
        let (harness, firestore, _) = try await createHarness()

        // 1. getDocument
        let docRef = firestore.document("users/test-doc")
        _ = try await docRef.getDocument()
        let getDocOp = try #require(harness.lastWorkerOp())
        #expect(getDocOp["method"]?.stringValue == "getDoc")
        #expect(getDocOp["actAs"]?.dictionaryValue?["mode"]?.stringValue == "anon")

        // 2. setData
        try await docRef.setData(["name": "Anon User"])
        let setDocOp = try #require(harness.lastWorkerOp())
        #expect(setDocOp["method"]?.stringValue == "setDoc")
        #expect(setDocOp["actAs"]?.dictionaryValue?["mode"]?.stringValue == "anon")

        // 3. updateData
        try await docRef.updateData(["name": "Updated Anon"])
        let updateDocOp = try #require(harness.lastWorkerOp())
        #expect(updateDocOp["method"]?.stringValue == "updateDoc")
        #expect(updateDocOp["actAs"]?.dictionaryValue?["mode"]?.stringValue == "anon")

        // 4. delete
        try await docRef.delete()
        let deleteDocOp = try #require(harness.lastWorkerOp())
        #expect(deleteDocOp["method"]?.stringValue == "deleteDoc")
        #expect(deleteDocOp["actAs"]?.dictionaryValue?["mode"]?.stringValue == "anon")

        // 5. getDocuments (Query)
        _ = try await firestore.collection("users").getDocuments()
        let getDocsOp = try #require(harness.lastWorkerOp())
        #expect(getDocsOp["method"]?.stringValue == "getDocs")
        #expect(getDocsOp["actAs"]?.dictionaryValue?["mode"]?.stringValue == "anon")
    }

    // ── 2. Authenticated Operations Stamp .asUser ────────────────────────────

    @Test("Authenticated Firestore operations stamp actAs: asUser with claims and tenant")
    func testAuthenticatedOperationsStampAsUser() async throws {
        let (harness, firestore, auth) = try await createHarness()

        let tenantLens = AuthLens.asUser(
            uid: "auth-user-99",
            tenant: "tenant-xyz",
            token: ["role": .string("manager")]
        )
        auth.switchLens(tenantLens)

        // 1. getDocument
        let docRef = firestore.document("users/auth-doc")
        _ = try await docRef.getDocument()
        let getDocOp = try #require(harness.lastWorkerOp())
        let actAs = try #require(getDocOp["actAs"]?.dictionaryValue)
        #expect(actAs["mode"]?.stringValue == "as")
        #expect(actAs["uid"]?.stringValue == "auth-user-99")
        #expect(actAs["tenant"]?.stringValue == "tenant-xyz")
        #expect(actAs["token"]?.dictionaryValue?["role"]?.stringValue == "manager")

        // 2. WriteBatch commit
        let batch = firestore.batch()
        batch.setData(["k": "v"], forDocument: docRef)
        try await batch.commit()
        let batchOp = try #require(harness.lastWorkerOp())
        #expect(batchOp["method"]?.stringValue == "batchCommit")
        let batchActAs = try #require(batchOp["actAs"]?.dictionaryValue)
        #expect(batchActAs["mode"]?.stringValue == "as")
        #expect(batchActAs["uid"]?.stringValue == "auth-user-99")

        // 3. Transaction commit
        _ = try await firestore.runTransaction { txn in
            let snap = try await txn.getDocument(docRef)
            txn.setData(["count": 1], forDocument: docRef)
            return snap.documentID
        }
        let txnOp = try #require(harness.lastWorkerOp())
        #expect(txnOp["method"]?.stringValue == "txnCommit")
        let txnActAs = try #require(txnOp["actAs"]?.dictionaryValue)
        #expect(txnActAs["mode"]?.stringValue == "as")
        #expect(txnActAs["uid"]?.stringValue == "auth-user-99")
    }

    // ── 3. Impersonation & Admin Bypass ──────────────────────────────────────

    @Test("Impersonation to admin bypass stamps actAs: admin")
    func testAdminBypassImpersonation() async throws {
        let (harness, firestore, auth) = try await createHarness()

        auth.switchLens(.admin)

        let docRef = firestore.document("locked/admin-only")
        _ = try await docRef.getDocument()
        let op = try #require(harness.lastWorkerOp())
        let actAs = try #require(op["actAs"]?.dictionaryValue)
        #expect(actAs["mode"]?.stringValue == "admin")

        // Revert to normal
        auth.switchLens(nil)
        _ = try await docRef.getDocument()
        let anonOp = try #require(harness.lastWorkerOp())
        let anonActAs = try #require(anonOp["actAs"]?.dictionaryValue)
        #expect(anonActAs["mode"]?.stringValue == "anon")
    }

    // ── 4. Snapshot Subscription Re-subscription ─────────────────────────────

    @Test("SnapshotSubscriptionCoordinator re-subscribes active listeners on auth transition")
    func testSnapshotReSubscriptionOnAuthTransition() async throws {
        let (harness, firestore, auth) = try await createHarness()

        let docRef = firestore.document("posts/live-post")

        let events = EventRecorder<String>()
        let registration = docRef.addSnapshotListener { snap, err in
            if let snap {
                events.record(snap.documentID)
            }
        }

        // Wait briefly for the initial worker-sub frame
        try await Task.sleep(nanoseconds: 30_000_000)

        // Verify initial subscription used anon lens
        let initialSubs = harness.sentMessages.filter { $0["type"]?.stringValue == "worker-sub" }
        #expect(!initialSubs.isEmpty)
        let initialSubPayload = initialSubs.first?["sub"]?.dictionaryValue
        #expect(initialSubPayload?["actAs"]?.dictionaryValue?["mode"]?.stringValue == "anon")

        // Switch to authenticated lens
        let memberLens = AuthLens.asUser(uid: "user-listener-1")
        auth.switchLens(memberLens)

        // Wait briefly for coordinator to detect transition and reconnect
        try await Task.sleep(nanoseconds: 50_000_000)

        let allSubs = harness.sentMessages.filter { $0["type"]?.stringValue == "worker-sub" }
        #expect(allSubs.count >= 2)
        let latestSubPayload = allSubs.last?["sub"]?.dictionaryValue
        #expect(latestSubPayload?["actAs"]?.dictionaryValue?["mode"]?.stringValue == "as")
        #expect(latestSubPayload?["actAs"]?.dictionaryValue?["uid"]?.stringValue == "user-listener-1")

        // Remove listener
        registration.remove()
    }
}

private final class EventRecorder<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [T] = []

    var events: [T] {
        lock.lock()
        defer { lock.unlock() }
        return _events
    }

    func record(_ event: T) {
        lock.lock()
        defer { lock.unlock() }
        _events.append(event)
    }
}
