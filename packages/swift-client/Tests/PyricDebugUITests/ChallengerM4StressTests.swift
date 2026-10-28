import Foundation
import Testing
@testable import PyricFirestore
@testable import FirebaseAuth
@testable import PyricDebugUI

@Suite("Milestone M4 Challenger: Swift Stress & Denial Edge Cases")
struct ChallengerM4StressTests {

    private func setupHarness() async throws -> (PyricDebugManager, Auth, PyricBridgeClient, MockDebugChannel) {
        let channel = MockDebugChannel()
        let client = PyricBridgeClient(channel: channel)

        let attachTask = Task {
            let frame = try await channel.awaitNextSentMessage()
            #expect(frame["type"]?.stringValue == "attach")
            try channel.simulateServerMessage([
                "type": "attach-ack",
                "protocol": 1,
                "peerConnected": true,
                "bridgeVersion": "0.1.0"
            ])
        }

        try await client.connect()
        _ = try await attachTask.value

        let app = FirebaseApp(name: "ChallengerApp-\(UUID().uuidString)")
        let auth = Auth(app: app, bridgeClient: client)
        let diagnostics = PyricDebugDiagnostics()
        let manager = await PyricDebugManager(auth: auth, bridgeClient: client, diagnostics: diagnostics)
        try await awaitRemoteLensSubscription(channel, auth, manager)

        return (manager, auth, client, channel)
    }

    @Test("RulesDenialReport handles sparse, empty, and adversarial payloads without crashing")
    func testDenialAdversarialPayloads() {
        // 1. Completely empty dictionary
        let emptyContext = AnySendable.from([String: Any]())
        let emptyReport = RulesDenialReport.from(denialContext: emptyContext, message: "Default error")
        #expect(emptyReport.file == "firestore.rules")
        #expect(emptyReport.citation == "firestore.rules")
        #expect(emptyReport.line == nil)
        #expect(emptyReport.col == nil)
        #expect(emptyReport.expression == nil)
        #expect(emptyReport.reasons == ["Default error"])
        #expect(emptyReport.authUid == nil)
        #expect(emptyReport.authTenant == nil)
        #expect(emptyReport.proposedData == nil)
        #expect(emptyReport.existingData == nil)
        #expect(emptyReport.failedFields.isEmpty)

        // 2. Adversarial payload with mixed non-string types in reasons and failedFields
        let mixedContext: [String: Any] = [
            "rule": [
                "file": "rules/complex.rules",
                "line": 42,
                "column": 15,
                "expression": "request.auth != null && request.auth.token.firebase.tenant == 'tenant-alpha'"
            ],
            "auth": [
                "uid": "adversary-swift",
                "token": [
                    "firebase": ["tenant": "tenant-beta"],
                    "roles": ["guest"]
                ]
            ],
            "reasons": [
                "Primary check failed",
                12345, // int
                true   // bool
            ],
            "failedFields": ["secretKey", 999],
            "request": [
                "method": "patch",
                "path": "tenants/tenant-alpha/docs/d1",
                "resourceData": [
                    "secretKey": "attack-value"
                ]
            ],
            "query": [
                "collectionGroup": "docs",
                "limit": 10
            ]
        ]

        let report = RulesDenialReport.from(denialContext: AnySendable.from(mixedContext), message: "Denied")
        #expect(report.file == "rules/complex.rules")
        #expect(report.line == 42)
        #expect(report.col == 15)
        #expect(report.citation == "rules/complex.rules:42:15")
        #expect(report.authUid == "adversary-swift")
        #expect(report.authTenant == "tenant-beta")
        // Non-string entries filtered by compactMap
        #expect(report.reasons == ["Primary check failed"])
        #expect(report.failedFields == ["secretKey"])
        #expect(report.query?["collectionGroup"]?.stringValue == "docs")

        // 3. Large data dictionary preservation
        var largeDict: [String: Any] = [:]
        for i in 0..<50 {
            largeDict["key_\(i)"] = "value_\(i)"
        }
        let largeContext: [String: Any] = [
            "request": [
                "resourceData": largeDict
            ]
        ]
        let largeReport = RulesDenialReport.from(denialContext: AnySendable.from(largeContext))
        #expect(largeReport.proposedData?.count == 50)
        #expect(largeReport.proposedData?["key_49"]?.stringValue == "value_49")
    }

    @Test("PyricDebugManager handles rapid Admin Bypass toggling and denial queue bursts")
    func testManagerStressAndDenialQueue() async throws {
        let (manager, _, _, _) = try await setupHarness()

        // 1. Toggling of Admin Bypass with async stream propagation
        for _ in 0..<5 {
            await manager.toggleAdminBypass(true)
            try await until { await manager.activeLens == .admin }
            #expect(await manager.isAdminBypass == true)

            await manager.toggleAdminBypass(false)
            try await until { await manager.activeLens == .anon }
            #expect(await manager.isAdminBypass == false)
        }

        // 2. Burst of 30 denials into manager (verifies bounded buffer of max 20)
        #expect(await manager.recentDenials.isEmpty)

        for i in 0..<30 {
            let denial = RulesDenialReport(
                citation: "firestore.rules:\(i)",
                expression: "rule_\(i)",
                errorMessage: "Error \(i)"
            )
            await manager.recordDenial(denial)
        }

        // Wait for the stream task to collect the last denial
        try await until { await manager.latestDenial?.citation == "firestore.rules:29" }

        // Strict assertion: Manager maintains a bounded FIFO buffer capped at 20 reports
        #expect(await manager.recentDenials.count == 20)
        #expect(await manager.latestDenial?.citation == "firestore.rules:29")

        // Clear reports
        await manager.clearDenials()
        #expect(await manager.recentDenials.isEmpty)
        #expect(await manager.latestDenial == nil)
    }

    @Test("Remote lens sync under rapid bursts of worker-event frames")
    func testRemoteLensSyncBurst() async throws {
        let (manager, auth, _, channel) = try await setupHarness()

        // Rapid stream of remote lens events. Every lens differs from the one
        // before it, and the last one, rapid-user-20, appears only once, so
        // waiting for it waits for the whole burst.
        for i in 0...20 {
            let isEven = i % 2 == 0
            let eventFrame: [String: Any] = isEven
                ? [
                    "type": "worker-event",
                    "event": "remote-lens",
                    "lens": [
                        "mode": "as",
                        "uid": "rapid-user-\(i)"
                    ]
                ]
                : [
                    "type": "worker-event",
                    "event": "remote-lens",
                    "lens": [
                        "mode": "admin"
                    ]
                ]
            try channel.simulateServerMessage(eventFrame)
        }

        let finalLens = AuthLens.asUser(uid: "rapid-user-20", tenant: nil, token: nil)
        try await until { await manager.activeLens == finalLens }

        // Final event (i=20, even) was rapid-user-20
        #expect(await manager.isAdminBypass == false)
        #expect(auth.currentAuthLens() == finalLens)
    }

    @Test("A denial recorded before the manager's observer task first runs reaches recentDenials")
    func testDenialRecordedBeforeObserverRuns() async throws {
        let (_, auth, client, _) = try await setupHarness()
        let diagnostics = PyricDebugDiagnostics()

        // One main-actor job, so the manager's observer tasks cannot run before the denial.
        let manager = await MainActor.run {
            let manager = PyricDebugManager(auth: auth, bridgeClient: client, diagnostics: diagnostics)
            diagnostics.record(denial: RulesDenialReport(
                citation: "firestore.rules:7:1",
                expression: "allow read: if false;",
                errorMessage: "Denied"
            ))
            return manager
        }

        try await until { await manager.latestDenial?.citation == "firestore.rules:7:1" }
    }

    @Test("Lens changes from several threads at once leave the manager on the current lens")
    func testConcurrentLensChangesSettleOnCurrentLens() async throws {
        let (manager, auth, _, _) = try await setupHarness()

        for round in 0..<300 {
            await withTaskGroup(of: Void.self) { group in
                for thread in 0..<4 {
                    group.addTask { auth.switchLens(.asUser(uid: "thread-\(thread)-\(round)", tenant: nil, token: nil)) }
                }
            }
            let current = auth.currentAuthLens()
            try await until { await manager.activeLens == current }
        }
    }
}
