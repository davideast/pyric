import Foundation
import Testing
@testable import PyricFirestore
@testable import FirebaseAuth

@Suite("Milestone 2 Challenger: Swift Boundary Stress Tests")
struct SwiftChallengerStressTests {

    private func createHarness(appName: String = "StressApp-\(UUID().uuidString)") async throws -> (ConformanceMockHarness, Firestore, Auth) {
        let harness = ConformanceMockHarness()
        let client = PyricBridgeClient(channel: harness)
        try await client.connect()

        let app = FirebaseApp(name: appName)
        let firestore = Firestore(bridgeClient: client, app: app)
        let auth = Auth(app: app, bridgeClient: client)
        AuthCredentialProviderRegistry.register(app: app, provider: auth)

        return (harness, firestore, auth)
    }

    // ── 1. Rapid Sequential Auth Switching ───────────────────────────────────

    @Test("50 rapid sequential auth transitions maintain exact lens state")
    func testRapidSequentialAuthTransitions() async throws {
        let (_, firestore, auth) = try await createHarness()

        for i in 0..<25 {
            // Anon
            auth.switchLens(.anon)
            #expect(firestore.effectiveAuthLens == .anon)
            #expect(auth.currentAuthLens() == .anon)

            // User A
            let userA = AuthLens.asUser(uid: "user-a-\(i)", tenant: "tenant-\(i)")
            auth.switchLens(userA)
            #expect(firestore.effectiveAuthLens == userA)
            #expect(auth.currentAuthLens() == userA)

            // Admin bypass
            auth.switchLens(.admin)
            #expect(firestore.effectiveAuthLens == .admin)
            #expect(auth.currentAuthLens() == .admin)

            // User B
            let userB = AuthLens.asUser(uid: "user-b-\(i)")
            auth.switchLens(userB)
            #expect(firestore.effectiveAuthLens == userB)
            #expect(auth.currentAuthLens() == userB)
        }

        auth.switchLens(nil)
        #expect(firestore.effectiveAuthLens == .anon)
    }

    // ── 2. Concurrent Operations During Rapid Auth Churn ─────────────────────

    @Test("Concurrent operations during rapid auth transitions never observe corrupt actAs")
    func testConcurrentOpsDuringAuthTransitions() async throws {
        let (harness, firestore, auth) = try await createHarness()

        let isRunning = ManagedAtomicBool(true)

        // Background task churning auth lens
        let authChurnTask = Task {
            var cycle = 0
            while isRunning.value {
                cycle += 1
                switch cycle % 4 {
                case 0:
                    auth.switchLens(.anon)
                case 1:
                    auth.switchLens(.asUser(uid: "alice-\(cycle)"))
                case 2:
                    auth.switchLens(.admin)
                default:
                    auth.switchLens(.asUser(uid: "bob-\(cycle)", tenant: "tenant-b"))
                }
                try? await Task.sleep(nanoseconds: 1_000_000) // 1ms
            }
        }

        // 60 concurrent document operations
        try await withThrowingTaskGroup(of: Void.self) { group in
            for i in 0..<60 {
                group.addTask {
                    let docRef = firestore.document("concurrent_stress/doc_\(i)")
                    switch i % 4 {
                    case 0:
                        _ = try await docRef.getDocument()
                    case 1:
                        try await docRef.setData(["count": i])
                    case 2:
                        try await docRef.updateData(["count": i + 1])
                    default:
                        try await docRef.delete()
                    }
                }
            }
            try await group.waitForAll()
        }

        isRunning.set(false)
        await authChurnTask.value

        // Validate all sent operations
        let opFrames = harness.sentMessages.filter { $0["type"]?.stringValue == "worker-op" }
        let docOps = opFrames.compactMap { $0["op"]?.dictionaryValue }
            .filter { dict in
                let method = dict["method"]?.stringValue ?? ""
                return ["getDoc", "setDoc", "updateDoc", "deleteDoc"].contains(method)
            }

        #expect(docOps.count >= 60)
        for op in docOps {
            let actAs = op["actAs"]?.dictionaryValue
            #expect(actAs != nil)
            let mode = actAs?["mode"]?.stringValue
            #expect(mode != nil && ["anon", "as", "admin"].contains(mode!))
            if mode == "as" {
                let uid = actAs?["uid"]?.stringValue
                #expect(uid != nil && !uid!.isEmpty)
            }
        }
    }

    // ── 3. Snapshot Unsubscription Cleanup & Zero Leaks ───────────────────────

    @Test("Dynamic snapshot re-subscriptions cancel prior subscriptions and leave zero leaks")
    func testSnapshotUnsubscriptionCleanupZeroLeaks() async throws {
        let (harness, firestore, auth) = try await createHarness()

        let docRef = firestore.document("leak_test/swift_doc")

        let receivedCount = ManagedAtomicInt(0)
        let registration = docRef.addSnapshotListener { snapshot, error in
            receivedCount.increment()
        }

        // Wait for initial sub
        try await Task.sleep(nanoseconds: 50_000_000) // 50ms

        // Trigger 5 rapid auth transitions
        for i in 0..<5 {
            auth.switchLens(.asUser(uid: "user-churn-\(i)"))
            try await Task.sleep(nanoseconds: 50_000_000) // 50ms
        }

        // Cancel snapshot listener
        registration.remove()
        try await Task.sleep(nanoseconds: 100_000_000) // 100ms

        // Collect all doc worker-sub and worker-unsub frames
        let docSubFrames = harness.sentMessages.filter { msg in
            guard msg["type"]?.stringValue == "worker-sub",
                  let sub = msg["sub"]?.dictionaryValue,
                  let target = sub["target"]?.dictionaryValue,
                  target["path"]?.stringValue == "leak_test/swift_doc" else {
                return false
            }
            return true
        }
        let unsubFrames = harness.sentMessages.filter { $0["type"]?.stringValue == "worker-unsub" }

        let subIds = Set(docSubFrames.compactMap { $0["subId"]?.stringValue })
        let unsubIds = Set(unsubFrames.compactMap { $0["subId"]?.stringValue })

        #expect(!subIds.isEmpty)
        let leakedIds = subIds.subtracting(unsubIds)
        #expect(leakedIds.isEmpty, "Leaked subscription IDs: \(leakedIds)")
    }
}

private final class ManagedAtomicBool: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: Bool

    init(_ value: Bool) { self._value = value }

    var value: Bool {
        lock.lock(); defer { lock.unlock() }; return _value
    }

    func set(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }; _value = value
    }
}

private final class ManagedAtomicInt: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: Int

    init(_ value: Int) { self._value = value }

    var value: Int {
        lock.lock(); defer { lock.unlock() }; return _value
    }

    func increment() {
        lock.lock(); defer { lock.unlock() }; _value += 1
    }
}
