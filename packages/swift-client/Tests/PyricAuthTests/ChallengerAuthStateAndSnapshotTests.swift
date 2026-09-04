import Foundation
import Testing
@testable import FirebaseAuth
@testable import PyricFirestore

@Suite("Challenger Auth State & Snapshot Stress Suite")
struct ChallengerAuthStateAndSnapshotTests {

    private func createHarness(appName: String = "ChallengerApp-\(UUID().uuidString)") async throws -> (MockAuthChannel, PyricBridgeClient, Firestore, Auth) {
        let channel = MockAuthChannel()
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

        let app = FirebaseApp(name: appName)
        let firestore = Firestore(bridgeClient: client, app: app)
        let auth = Auth(app: app, bridgeClient: client)
        AuthCredentialProviderRegistry.register(app: app, provider: auth)

        return (channel, client, firestore, auth)
    }

    private func simulateSignInSuccess(channel: MockAuthChannel, uid: String = "user-alice") async throws {
        let frame = try await channel.awaitNextSentMessage()
        #expect(frame["type"]?.stringValue == "worker-op")
        let opId = frame["id"]?.stringValue ?? "rop-1"
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": opId,
            "ok": true,
            "res": [
                "user": [
                    "uid": uid,
                    "email": "\(uid)@example.com",
                    "emailVerified": true,
                    "displayName": "Alice",
                    "isAnonymous": false,
                    "providerId": "password"
                ],
                "providerId": "password",
                "operationType": "signIn"
            ]
        ])
    }

    // ── 1. Auth State Stream Lifecycle Ordering ──────────────────────────────

    @Test("Verifies authStateDidChangeStream lifecycle: initial nil -> sign in user -> sign out nil")
    func testAuthStateLifecycle() async throws {
        let (channel, _, _, auth) = try await createHarness()

        var authIterator = auth.authStateDidChangeStream.makeAsyncIterator()

        // 1. Initial event must be nil
        let initial = await authIterator.next()
        #expect(initial != nil && initial! == nil)

        // 2. Sign in as user-alice
        let signInTask = Task {
            try await auth.signIn(withEmail: "alice@example.com", password: "password123")
        }
        try await simulateSignInSuccess(channel: channel, uid: "user-alice")
        _ = try await signInTask.value

        let signedIn = await authIterator.next()
        #expect(signedIn != nil && signedIn!?.uid == "user-alice")

        // 3. Sign out -> emits nil
        let signOutTask = Task {
            try auth.signOut()
        }
        // Consume signOut op if dispatched
        let outFrame = try await channel.awaitNextSentMessage()
        if outFrame["type"]?.stringValue == "worker-op" {
            let outId = outFrame["id"]?.stringValue ?? "rop-2"
            try channel.simulateServerMessage([
                "type": "worker-res",
                "id": outId,
                "ok": true,
                "res": NSNull()
            ])
        }
        _ = try await signOutTask.value

        let signedOut = await authIterator.next()
        #expect(signedOut != nil && signedOut! == nil)
    }

    @Test("Verifies ID token listener lifecycle: initial nil -> sign in user -> token change -> sign out nil")
    func testIdTokenLifecycleAndTokenChange() async throws {
        let (channel, _, _, auth) = try await createHarness()

        let tokenEvents = EventRecorder<String?>()
        let handle = auth.addIDTokenDidChangeListener { _, user in
            tokenEvents.record(user?.uid)
        }

        // 1. Initial event must be nil
        #expect(tokenEvents.events == [nil])

        // 2. Sign in as user-alice
        let signInTask = Task {
            try await auth.signIn(withEmail: "alice@example.com", password: "password123")
        }
        try await simulateSignInSuccess(channel: channel, uid: "user-alice")
        let user = try await signInTask.value.user

        // Wait up to 50ms for listener callback
        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(tokenEvents.events == [nil, "user-alice"])

        // 3. User refreshes ID token via getIDTokenResult(forcingRefresh: true)
        let tokenResultTask = Task {
            try await user.getIDTokenResult(forcingRefresh: true)
        }
        let tokenOpFrame = try await channel.awaitNextSentMessage(timeoutSeconds: 2.0)
        let tokenOpId = tokenOpFrame["id"]?.stringValue ?? "rop-99"
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": tokenOpId,
            "ok": true,
            "res": [
                "token": "refreshed-jwt-token-999",
                "claims": ["admin": true],
                "expirationTime": "2026-09-04T19:00:00.000Z",
                "authTime": "2026-09-04T17:00:00.000Z",
                "issuedAtTime": "2026-09-04T18:00:00.000Z",
                "signInProvider": "password"
            ]
        ])
        _ = try await tokenResultTask.value
        try await Task.sleep(nanoseconds: 50_000_000)

        // Does ID token listener emit on token refresh?
        #expect(tokenEvents.events == [nil, "user-alice", "user-alice"])

        // 4. Sign out
        try auth.signOut()
        let outFrame = try await channel.awaitNextSentMessage(timeoutSeconds: 2.0)
        if outFrame["type"]?.stringValue == "worker-op" {
            let outId = outFrame["id"]?.stringValue ?? "rop-out"
            try channel.simulateServerMessage([
                "type": "worker-res",
                "id": outId,
                "ok": true,
                "res": NSNull()
            ])
        }
        try await Task.sleep(nanoseconds: 50_000_000)

        #expect(tokenEvents.events == [nil, "user-alice", "user-alice", nil])
        auth.removeIDTokenDidChangeListener(handle)
    }

    // ── 2. Snapshot Re-subscription on Real Auth Transitions ─────────────────

    @Test("Verifies SnapshotSubscriptionCoordinator automatically re-subscribes on signIn and signOut")
    func testSnapshotReSubscriptionOnSignInAndSignOut() async throws {
        let (channel, _, firestore, auth) = try await createHarness()

        let docRef = firestore.document("users/alice")
        let recorder = EventRecorder<String>()

        let reg = docRef.addSnapshotListener { snap, err in
            if let snap {
                recorder.record(snap.documentID)
            }
        }

        // Wait for initial worker-sub
        let initialSubFrame = try await channel.awaitNextSentMessage()
        #expect(initialSubFrame["type"]?.stringValue == "worker-sub")
        let initialSubPayload = initialSubFrame["sub"]?.dictionaryValue
        #expect(initialSubPayload?["actAs"]?.dictionaryValue?["mode"]?.stringValue == "anon")

        // Now perform signIn(withEmail:password:)
        let signInTask = Task {
            try await auth.signIn(withEmail: "alice@example.com", password: "password")
        }
        try await simulateSignInSuccess(channel: channel, uid: "user-alice")
        _ = try await signInTask.value

        // Coordinator should cancel previous subscription (worker-unsub) and send new worker-sub with mode: as
        var reSubFrame: [String: AnySendable]?
        for _ in 0..<5 {
            let frame = try await channel.awaitNextSentMessage(timeoutSeconds: 2.0)
            if frame["type"]?.stringValue == "worker-sub" {
                reSubFrame = frame
                break
            }
        }
        #expect(reSubFrame != nil)
        let reSubPayload = reSubFrame?["sub"]?.dictionaryValue
        #expect(reSubPayload?["actAs"]?.dictionaryValue?["mode"]?.stringValue == "as")
        #expect(reSubPayload?["actAs"]?.dictionaryValue?["uid"]?.stringValue == "user-alice")

        // Now signOut
        try auth.signOut()

        // Coordinator should cancel (worker-unsub) and re-subscribe with mode: anon
        var postSignOutSub: [String: AnySendable]?
        for _ in 0..<5 {
            let frame = try await channel.awaitNextSentMessage(timeoutSeconds: 2.0)
            if frame["type"]?.stringValue == "worker-sub" {
                postSignOutSub = frame
                break
            }
        }
        #expect(postSignOutSub != nil)
        let postSignOutPayload = postSignOutSub?["sub"]?.dictionaryValue
        #expect(postSignOutPayload?["actAs"]?.dictionaryValue?["mode"]?.stringValue == "anon")

        reg.remove()
    }
}

private final class EventRecorder<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [T] = []

    var events: [T] {
        lock.lock(); defer { lock.unlock() }; return _events
    }

    func record(_ event: T) {
        lock.lock(); defer { lock.unlock() }; _events.append(event)
    }
}
