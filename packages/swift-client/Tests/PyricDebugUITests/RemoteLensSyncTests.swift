import Foundation
import Testing
@testable import PyricFirestore
@testable import FirebaseAuth
@testable import PyricDebugUI

@Suite("Remote Lens Push Synchronization Tests")
struct RemoteLensSyncTests {

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

        let app = FirebaseApp(name: "RemoteLensApp-\(UUID().uuidString)")
        let auth = Auth(app: app, bridgeClient: client)
        let diagnostics = PyricDebugDiagnostics()
        let manager = await PyricDebugManager(auth: auth, bridgeClient: client, diagnostics: diagnostics)

        return (manager, auth, client, channel)
    }

    @Test("Desktop Studio push event remote-lens admin updates Auth and Manager activeLens")
    func testRemoteLensAdminPush() async throws {
        let (manager, auth, _, channel) = try await setupHarness()

        #expect(await manager.activeLens == .anon)

        try channel.simulateServerMessage([
            "type": "worker-event",
            "event": "remote-lens",
            "lens": [
                "mode": "admin"
            ]
        ])

        // Allow stream propagation
        try await Task.sleep(nanoseconds: 30_000_000)

        #expect(await manager.activeLens == .admin)
        #expect(await manager.isAdminBypass == true)
        #expect(auth.currentAuthLens() == .admin)
    }

    @Test("Desktop Studio push event remote-lens asUser updates identity and tenant")
    func testRemoteLensAsUserPush() async throws {
        let (manager, auth, _, channel) = try await setupHarness()

        try channel.simulateServerMessage([
            "type": "worker-event",
            "event": "remote-lens",
            "lens": [
                "mode": "as",
                "uid": "remote-bob",
                "tenant": "tenant-saas",
                "token": [
                    "role": "auditor"
                ]
            ]
        ])

        // Allow stream propagation
        try await Task.sleep(nanoseconds: 30_000_000)

        let expectedLens = AuthLens.asUser(
            uid: "remote-bob",
            tenant: "tenant-saas",
            token: ["role": .string("auditor")]
        )

        #expect(await manager.activeLens == expectedLens)
        #expect(auth.currentAuthLens() == expectedLens)
    }
}
