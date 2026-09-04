import Foundation
import Testing
@testable import PyricFirestore
@testable import FirebaseAuth
@testable import PyricDebugUI

@Suite("Pyric Debug Manager Tests")
struct PyricDebugManagerTests {

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

        let app = FirebaseApp(name: "ManagerTestApp-\(UUID().uuidString)")
        let auth = Auth(app: app, bridgeClient: client)
        let diagnostics = PyricDebugDiagnostics()
        let manager = await PyricDebugManager(auth: auth, bridgeClient: client, diagnostics: diagnostics)

        return (manager, auth, client, channel)
    }

    @Test("Fetches sandbox users via auth.listUsers and updates manager.users")
    func testRefreshUsers() async throws {
        let (manager, _, _, channel) = try await setupHarness()

        let refreshTask = Task {
            await manager.refreshUsers()
        }

        let opFrame = try await channel.awaitNextSentMessage()
        #expect(opFrame["type"]?.stringValue == "worker-op")
        let opId = opFrame["id"]?.stringValue ?? "rop-1"
        let method = opFrame["op"]?["method"]?.stringValue
        #expect(method == "auth.listUsers")

        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": opId,
            "ok": true,
            "res": [
                [
                    "uid": "user-alice",
                    "email": "alice@example.com",
                    "displayName": "Alice Admin",
                    "customClaims": ["role": "admin"]
                ],
                [
                    "uid": "user-bob",
                    "email": "bob@example.com",
                    "displayName": "Bob Member",
                    "tenantId": "tenant-saas"
                ]
            ]
        ])

        _ = await refreshTask.value

        let users = await manager.users
        #expect(users.count == 2)
        #expect(users[0].uid == "user-alice")
        #expect(users[0].displayName == "Alice Admin")
        #expect(users[1].uid == "user-bob")
        #expect(users[1].tenantId == "tenant-saas")
    }

    @Test("Selecting a user updates active lens and Auth credential provider")
    func testSelectUser() async throws {
        let (manager, auth, _, _) = try await setupHarness()

        let user = SandboxUserRecord(
            uid: "user-charlie",
            email: "charlie@example.com",
            displayName: "Charlie",
            tenantId: "tenant-beta",
            customClaims: ["editor": .bool(true)]
        )

        await manager.selectUser(user)

        // Allow lens task to propagate
        try await Task.sleep(nanoseconds: 20_000_000)

        let activeLens = await manager.activeLens
        #expect(activeLens == .asUser(uid: "user-charlie", tenant: "tenant-beta", token: ["editor": .bool(true)]))
        #expect(auth.currentAuthLens() == activeLens)
    }

    @Test("Toggling Admin Bypass switches between admin and normal lens")
    func testToggleAdminBypass() async throws {
        let (manager, auth, _, _) = try await setupHarness()

        #expect(await manager.isAdminBypass == false)

        await manager.toggleAdminBypass(true)
        try await Task.sleep(nanoseconds: 20_000_000)

        #expect(await manager.isAdminBypass == true)
        #expect(await manager.activeLens == .admin)
        #expect(auth.currentAuthLens() == .admin)

        await manager.toggleAdminBypass(false)
        try await Task.sleep(nanoseconds: 20_000_000)

        #expect(await manager.isAdminBypass == false)
        #expect(await manager.activeLens == .anon)
    }

    @Test("Records and clears denial reports cleanly")
    func testDenialRecordingAndClearing() async throws {
        let (manager, _, _, _) = try await setupHarness()

        let report = RulesDenialReport(
            citation: "firestore.rules:20:5",
            expression: "allow read: if false;",
            reasons: ["Condition failed"],
            errorMessage: "Permission denied."
        )

        await manager.recordDenial(report)
        try await Task.sleep(nanoseconds: 20_000_000)

        var denials = await manager.recentDenials
        #expect(denials.count == 1)
        #expect(denials.first?.citation == "firestore.rules:20:5")

        await manager.clearDenials()
        denials = await manager.recentDenials
        #expect(denials.isEmpty)
    }

    @Test("Bridge client denial stream automatically propagates into manager recent denials")
    func testBridgeDenialPropagation() async throws {
        let (manager, _, client, channel) = try await setupHarness()

        let opTask = Task<AnySendable, Error> {
            try await client.op(method: "getDoc", params: ["path": "restricted/resource"])
        }
        let frame = try await channel.awaitNextSentMessage()
        let id = try #require(frame["id"]?.stringValue)

        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": id,
            "ok": false,
            "error": [
                "code": "permission-denied",
                "message": "Missing read permissions",
                "denialContext": [
                    "rule": [
                        "file": "firestore.rules",
                        "line": 88,
                        "col": 4,
                        "citation": "firestore.rules:88:4",
                        "expression": "allow read: if false;"
                    ],
                    "reasons": ["CEL condition evaluated to false"]
                ]
            ] as [String: Any]
        ])

        _ = try? await opTask.value
        try await Task.sleep(nanoseconds: 50_000_000)

        let denials = await manager.recentDenials
        #expect(denials.count == 1)
        #expect(denials.first?.citation == "firestore.rules:88:4")
        #expect(denials.first?.expression == "allow read: if false;")
    }

    @Test("PyricDebugDiagnostics reset clears history, cancels observation, and finishes streams")
    func testDiagnosticsReset() async throws {
        let channel = MockDebugChannel()
        let client = PyricBridgeClient(channel: channel)
        let diagnostics = PyricDebugDiagnostics(bridgeClient: client)

        diagnostics.record(denial: RulesDenialReport(
            citation: "firestore.rules:10:2",
            expression: "allow write: if false;",
            errorMessage: "Denied"
        ))
        #expect(diagnostics.history.count == 1)

        diagnostics.reset()
        #expect(diagnostics.history.isEmpty)

        final class StreamState: @unchecked Sendable {
            var isClosed = false
        }
        let state = StreamState()
        let stream = diagnostics.denialStream
        Task {
            for await _ in stream { }
            state.isClosed = true
        }
        try await Task.sleep(nanoseconds: 10_000_000)
        diagnostics.reset()
        try await Task.sleep(nanoseconds: 20_000_000)
        #expect(state.isClosed == true)
    }

    @Test("Firestore addRulesDenialListener captures denials and unregisters cleanly")
    func testFirestoreRulesDenialListener() async throws {
        let channel = MockDebugChannel()
        let client = PyricBridgeClient(channel: channel)
        let connectTask = Task { try await client.connect() }
        _ = try await channel.awaitNextSentMessage()
        try channel.simulateServerMessage(["type": "attach-ack", "peerConnected": true])
        try await connectTask.value

        let firestore = Firestore(bridgeClient: client)

        final class ListenerBox: @unchecked Sendable {
            var captured: [PyricBridgeError] = []
        }
        let box = ListenerBox()

        let registration = firestore.addRulesDenialListener { error in
            box.captured.append(error)
        }

        let opTask = Task<AnySendable, Error> {
            try await client.op(method: "getDoc", params: ["path": "secret"])
        }
        let frame = try await channel.awaitNextSentMessage()
        let id = try #require(frame["id"]?.stringValue)
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": id,
            "ok": false,
            "error": [
                "code": "permission-denied",
                "message": "Permission denied",
                "denialContext": ["rule": ["line": 99]]
            ] as [String: Any]
        ])
        _ = try? await opTask.value
        try await Task.sleep(nanoseconds: 30_000_000)

        #expect(box.captured.count == 1)
        #expect(box.captured.first?.denialContext?["rule"]?["line"]?.intValue == 99)

        registration.remove()

        let opTask2 = Task<AnySendable, Error> {
            try await client.op(method: "getDoc", params: ["path": "secret2"])
        }
        let frame2 = try await channel.awaitNextSentMessage()
        let id2 = try #require(frame2["id"]?.stringValue)
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": id2,
            "ok": false,
            "error": [
                "code": "permission-denied",
                "message": "Permission denied",
                "denialContext": ["rule": ["line": 100]]
            ] as [String: Any]
        ])
        _ = try? await opTask2.value
        try await Task.sleep(nanoseconds: 30_000_000)

        #expect(box.captured.count == 1)

        await client.disconnect()
    }
}
