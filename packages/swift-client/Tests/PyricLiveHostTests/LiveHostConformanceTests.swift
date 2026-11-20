import Foundation
import Testing
@testable import PyricFirestore
import FirebaseAuth
import PyricDatabase

@Suite("Pyric Live-Host Conformance Suite", .serialized)
struct LiveHostConformanceTests {

    @Test("RFC 6455 frame codec masks, unmasks, and encodes 7-bit, 16-bit, and close frames")
    func rfc6455FrameCodecRoundTrip() throws {
        let shortPayload = Array("{\"type\":\"attach\",\"protocol\":1}".utf8)
        let maskKey: [UInt8] = [0x37, 0xFA, 0x21, 0x3D]
        let shortWire = WebSocketFrameCodec.encodeClientFrame(
            opcode: 0x01,
            payload: shortPayload,
            maskKey: maskKey
        )
        let decodedShort = try #require(try WebSocketFrameCodec.decodeFrame(from: shortWire[...]))
        #expect(decodedShort.fin == true)
        #expect(decodedShort.opcode == 0x01)
        #expect(decodedShort.payload == shortPayload)
        #expect(decodedShort.bytesConsumed == shortWire.count)

        let truncated = shortWire.dropLast()
        #expect(try WebSocketFrameCodec.decodeFrame(from: truncated) == nil)

        let mediumPayload = [UInt8](repeating: 0x61, count: 320)
        let mediumWire = WebSocketFrameCodec.encodeClientFrame(
            opcode: 0x01,
            payload: mediumPayload,
            maskKey: maskKey
        )
        let decodedMedium = try #require(try WebSocketFrameCodec.decodeFrame(from: mediumWire[...]))
        #expect(decodedMedium.payload == mediumPayload)
        #expect(decodedMedium.bytesConsumed == 4 + 4 + mediumPayload.count)

        let closePayload = WebSocketFrameCodec.encodeClosePayload(closeCode: 1008, reason: "policy")
        let decodedClose = WebSocketFrameCodec.decodeClosePayload(closePayload)
        #expect(decodedClose.code == 1008)
        #expect(decodedClose.reason == "policy")
    }

    @Test("Auth and multi-instance RTDB conformance over live WebSocket bridge")
    func liveHostAuthAndMultiShardRtdbConformance() async throws {
        guard let rawBridgeURL = ProcessInfo.processInfo.environment["PYRIC_LIVE_BRIDGE_URL"],
              !rawBridgeURL.isEmpty else {
            return
        }
        let bridgeURL = try #require(URL(string: rawBridgeURL))
        let host = bridgeURL.host ?? "127.0.0.1"
        let port = try #require(bridgeURL.port)

        try await withLiveSession(host: host, port: port) { auth, mainDb, shard00, shard01, shard09 in
            #expect(auth.currentUser == nil)

            // 1. Unauthenticated access respects each instance's independent ruleset.
            await expectPermissionDenied {
                try await mainDb.reference(withPath: "users/unauthed").setValue(["displayName": "Blocked"] as [String: Any])
            }
            await expectPermissionDenied {
                _ = try await shard00.reference(withPath: "rooms/r1").getData()
            }
            let publicCatalogSnap = try await shard01.reference(withPath: "catalog/featured").getData()
            #expect(publicCatalogSnap.exists() == false)
            await expectPermissionDenied {
                try await shard01.reference(withPath: "catalog/featured").setValue(["title": "ReadOnly"] as [String: Any])
            }

            // 2. Create user with email/password and verify JWT ID token issuance + forced refresh.
            let created = try await auth.createUser(
                withEmail: "pilot@example.test",
                password: "correct-horse-battery"
            )
            let emailUid = created.user.uid
            #expect(!emailUid.isEmpty)
            #expect(created.user.email == "pilot@example.test")
            #expect(created.user.isAnonymous == false)
            #expect(auth.currentUser?.uid == emailUid)

            let token = try await created.user.getIDToken()
            #expect(token.split(separator: ".").count == 3)
            let refreshedToken = try await created.user.getIDToken(forcingRefresh: true)
            #expect(refreshedToken.split(separator: ".").count == 3)

            // 3. Default RTDB instance enforces $uid owner isolation.
            try await mainDb.reference(withPath: "users/\(emailUid)").setValue([
                "displayName": "Pilot One",
                "rank": "captain",
            ] as [String: Any])
            let ownProfileSnap = try await mainDb.reference(withPath: "users/\(emailUid)").getData()
            #expect(ownProfileSnap.exists() == true)
            let ownProfile = ownProfileSnap.value as? [String: Any]
            #expect(ownProfile?["displayName"] as? String == "Pilot One")
            #expect(ownProfile?["rank"] as? String == "captain")

            await expectPermissionDenied {
                try await mainDb.reference(withPath: "users/other-uid").setValue(["displayName": "Spoof"] as [String: Any])
            }

            // 4. Named shard-00 streams real-time value updates and enforces owner == auth.uid.
            let roomRef = shard00.reference(withPath: "rooms/r1")
            let streamTask = Task<[String], Error> {
                var observed: [String] = []
                for try await snap in roomRef.valueStream {
                    if !snap.exists() {
                        observed.append("<empty>")
                        try await roomRef.setValue([
                            "owner": emailUid,
                            "topic": "navigation",
                        ] as [String: Any])
                    } else if let dict = snap.value as? [String: Any],
                              let topic = dict["topic"] as? String {
                        observed.append(topic)
                        break
                    }
                }
                return observed
            }
            let observedTopics = try await streamTask.value
            #expect(observedTopics == ["<empty>", "navigation"])

            await expectPermissionDenied {
                try await roomRef.setValue([
                    "owner": "spoof-uid",
                    "topic": "hijack",
                ] as [String: Any])
            }

            // 5. Cross-shard isolation: shard-01 and shard-09 hold separate data and separate rules.
            await expectPermissionDenied {
                _ = try await shard01.reference(withPath: "rooms/r1").getData()
            }
            await expectPermissionDenied {
                try await shard01.reference(withPath: "ops/deploy").setValue(["state": "active"] as [String: Any])
            }

            try await shard09.reference(withPath: "shards/shard-09/status").setValue("ready")
            let shard09Snap = try await shard09.reference(withPath: "shards/shard-09/status").getData()
            #expect(shard09Snap.value as? String == "ready")
            await expectPermissionDenied {
                try await shard09.reference(withPath: "shards/shard-00/status").setValue("wrong-shard")
            }

            // 6. Sign-out revokes auth-gated reads; email sign-in and anonymous sign-in transition cleanly.
            try auth.signOut()
            #expect(auth.currentUser == nil)
            await expectPermissionDenied {
                _ = try await mainDb.reference(withPath: "users/\(emailUid)").getData()
            }
            await expectPermissionDenied {
                _ = try await shard00.reference(withPath: "rooms/r1").getData()
            }

            let signedBackIn = try await auth.signIn(
                withEmail: "pilot@example.test",
                password: "correct-horse-battery"
            )
            #expect(signedBackIn.user.uid == emailUid)
            let restoredProfile = try await mainDb.reference(withPath: "users/\(emailUid)").getData()
            #expect((restoredProfile.value as? [String: Any])?["displayName"] as? String == "Pilot One")

            try auth.signOut()
            let anonSession = try await auth.signInAnonymously()
            #expect(anonSession.user.isAnonymous == true)
            #expect(anonSession.user.uid != emailUid)

            let roomAsAnon = try await shard00.reference(withPath: "rooms/r1").getData()
            #expect((roomAsAnon.value as? [String: Any])?["topic"] as? String == "navigation")
            await expectPermissionDenied {
                _ = try await mainDb.reference(withPath: "users/\(emailUid)").getData()
            }
        }
    }

    private func withLiveSession(
        host: String,
        port: Int,
        body: (Auth, Database, Database, Database, Database) async throws -> Void
    ) async throws {
        let app = FirebaseApp(name: "swift-live-\(UUID().uuidString)")
        let firestore = Firestore.firestore(app: app)
        firestore.useEmulator(host: host, port: port)
        #expect(firestore.bridgeClient.endpoint.port == port)
        let auth = Auth.auth(app: app)
        let mainDb = Database.database(app: app)
        let shard00 = Database.database(app: app, url: "https://shard-00.firebaseio.com")
        let shard01 = Database.database(app: app, url: "https://shard-01.firebaseio.com")
        let shard09 = Database.database(app: app, url: "https://shard-09.firebaseio.com")

        do {
            try await body(auth, mainDb, shard00, shard01, shard09)
            await firestore.bridgeClient.disconnect()
            Auth.reset()
            Database.reset()
        } catch {
            await firestore.bridgeClient.disconnect()
            Auth.reset()
            Database.reset()
            throw error
        }
    }

    private func expectPermissionDenied(_ operation: () async throws -> Void) async {
        do {
            try await operation()
            Issue.record("Expected permission-denied error, but operation succeeded")
        } catch let bridgeError as PyricBridgeError {
            let isPermissionDenied = bridgeError.code == .permissionDenied
                || bridgeError.rawCode == "PERMISSION_DENIED"
            #expect(isPermissionDenied, "Unexpected bridge error code: \(bridgeError.rawCode)")
        } catch {
            Issue.record("Expected PyricBridgeError permission-denied, got: \(error)")
        }
    }
}
