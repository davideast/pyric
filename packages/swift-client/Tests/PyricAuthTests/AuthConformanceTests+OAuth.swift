import Foundation
import Testing
@testable import FirebaseAuth
@testable import PyricFirestore

extension AuthConformanceTests {

    private func createOAuthHarness(appName: String = "OAuthTestApp-\(UUID().uuidString)") async throws -> (Auth, MockAuthChannel) {
        let channel = MockAuthChannel()
        let client = PyricBridgeClient(channel: channel)
        let app = FirebaseApp(name: appName)
        let auth = Auth(app: app, bridgeClient: client)

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
        return (auth, channel)
    }

    // ── 9. OAuth Providers & Credential Authentication (Rows 55–58) ───────────
    @Test func `auth-swift#55: GoogleAuthProvider.credential(withIDToken:accessToken:) constructs Google AuthCredential`() {
        let cred = GoogleAuthProvider.credential(withIDToken: "google-id-token", accessToken: "google-access-token")
        #expect(cred.provider == "google.com")
        let wire = cred.toWireParams()
        #expect(wire["providerId"]?.stringValue == "google.com")
        #expect(wire["idToken"]?.stringValue == "google-id-token")
        #expect(wire["accessToken"]?.stringValue == "google-access-token")
    }

    @Test func `auth-swift#56: OAuthProvider.credential(withProviderID:idToken:rawNonce:accessToken:) constructs OAuthCredential`() {
        let cred = OAuthProvider.credential(
            withProviderID: "apple.com",
            idToken: "apple-id-token",
            rawNonce: "nonce-123",
            accessToken: "apple-access-token"
        )
        #expect(cred.provider == "apple.com")
        #expect(cred.idToken == "apple-id-token")
        #expect(cred.accessToken == "apple-access-token")
        #expect(cred.rawNonce == "nonce-123")
        let wire = cred.toWireParams()
        #expect(wire["providerId"]?.stringValue == "apple.com")
        #expect(wire["idToken"]?.stringValue == "apple-id-token")
        #expect(wire["accessToken"]?.stringValue == "apple-access-token")
        #expect(wire["rawNonce"]?.stringValue == "nonce-123")
    }

    @Test func `auth-swift#57: Auth.signIn(with:) async authenticates with AuthCredential`() async throws {
        let (auth, channel) = try await createOAuthHarness()
        let cred = GoogleAuthProvider.credential(withIDToken: "google-jwt", accessToken: "google-acc")
        let task = Task { try await auth.signIn(with: cred) }

        let frame = try await channel.awaitNextSentMessage()
        #expect(frame["op"]?["method"]?.stringValue == "auth.signInWithCredential")
        #expect(frame["op"]?["providerId"]?.stringValue == "google.com")
        let opId = frame["id"]?.stringValue ?? "op-oauth-1"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true,
            "res": [
                "user": [
                    "uid": "google-user-123",
                    "email": "oauth@example.com",
                    "displayName": "OAuth User",
                    "providerId": "firebase",
                    "providerData": [["uid": "google-user-123", "email": "oauth@example.com", "providerId": "google.com"]]
                ],
                "providerId": "google.com",
                "operationType": "signIn"
            ]
        ])

        let res = try await task.value
        #expect(res.user.uid == "google-user-123")
        #expect(res.user.email == "oauth@example.com")
        #expect(res.additionalUserInfo?.providerID == "google.com")
        #expect(auth.currentUser?.uid == "google-user-123")
    }

    @Test func `auth-swift#58: Auth.signIn(with:completion:) callback authenticates with AuthCredential`() async throws {
        let (auth, channel) = try await createOAuthHarness()
        let cred = OAuthProvider.credential(withProviderID: "github.com", idToken: "gh-jwt", accessToken: "gh-acc")
        let exp = OAuthAsyncExpectation()

        auth.signIn(with: cred) { res, err in
            #expect(err == nil)
            #expect(res?.user.uid == "github-user-456")
            exp.fulfill()
        }

        let frame = try await channel.awaitNextSentMessage()
        #expect(frame["op"]?["method"]?.stringValue == "auth.signInWithCredential")
        #expect(frame["op"]?["providerId"]?.stringValue == "github.com")
        let opId = frame["id"]?.stringValue ?? "op-oauth-2"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true,
            "res": [
                "user": [
                    "uid": "github-user-456",
                    "email": "github@example.com",
                    "providerId": "firebase"
                ],
                "providerId": "github.com",
                "operationType": "signIn"
            ]
        ])

        await exp.wait()
    }
}

private final class OAuthAsyncExpectation: @unchecked Sendable {
    private let lock = NSLock()
    private var fulfilled = false
    private var continuation: CheckedContinuation<Void, Never>?
    func fulfill() {
        lock.lock(); defer { lock.unlock() }
        guard !fulfilled else { return }; fulfilled = true
        continuation?.resume(); continuation = nil
    }
    func wait() async {
        let isDone = { lock.lock(); defer { lock.unlock() }; return fulfilled }()
        if isDone { return }
        await withCheckedContinuation { cont in
            lock.lock(); defer { lock.unlock() }
            if fulfilled { cont.resume() } else { continuation = cont }
        }
    }
}
