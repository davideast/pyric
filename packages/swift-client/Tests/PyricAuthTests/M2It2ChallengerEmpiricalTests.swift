import Foundation
import Testing
@testable import FirebaseAuth
@testable import PyricFirestore

@Suite("Milestone M2 Iteration 2 Challenger: Swift Empirical Verification")
struct M2It2ChallengerEmpiricalTests {

    private func createHarness(appName: String = "M2It2ChallengerApp-\(UUID().uuidString)") async throws -> (MockAuthChannel, PyricBridgeClient, Firestore, Auth) {
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

    // ── Test 1: idTokenDidChangeStream & addIDTokenDidChangeListener on Refresh ──

    @Test("Verify idTokenDidChangeStream and addIDTokenDidChangeListener emit [nil, user, user, nil] on token refresh")
    func testIdTokenStreamAndListenerEmitOnRefresh() async throws {
        let (channel, _, _, auth) = try await createHarness()

        let listenerEvents = EventRecorder<String?>()
        let handle = auth.addIDTokenDidChangeListener { _, user in
            listenerEvents.record(user?.uid)
        }

        var streamIterator = auth.idTokenDidChangeStream.makeAsyncIterator()

        // 1. Initial event must be nil on both
        let initialStream = await streamIterator.next()
        #expect(initialStream != nil && initialStream! == nil)
        #expect(listenerEvents.events == [nil])

        // 2. Sign in as user-alice
        let signInTask = Task {
            try await auth.signIn(withEmail: "alice@example.com", password: "password123")
        }
        try await simulateSignInSuccess(channel: channel, uid: "user-alice")
        let user = try await signInTask.value.user

        let signedInStream = await streamIterator.next()
        #expect(signedInStream != nil && signedInStream!?.uid == "user-alice")

        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(listenerEvents.events == [nil, "user-alice"])

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
                "token": "refreshed-jwt-token-1",
                "claims": ["role": "manager"],
                "expirationTime": "2026-09-04T19:00:00.000Z",
                "authTime": "2026-09-04T17:00:00.000Z",
                "issuedAtTime": "2026-09-04T18:00:00.000Z",
                "signInProvider": "password"
            ]
        ])
        _ = try await tokenResultTask.value

        let refreshedStream = await streamIterator.next()
        #expect(refreshedStream != nil && refreshedStream!?.uid == "user-alice")

        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(listenerEvents.events == [nil, "user-alice", "user-alice"])

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

        let signedOutStream = await streamIterator.next()
        #expect(signedOutStream != nil && signedOutStream! == nil)

        try await Task.sleep(nanoseconds: 30_000_000)
        #expect(listenerEvents.events == [nil, "user-alice", "user-alice", nil])

        auth.removeIDTokenDidChangeListener(handle)
    }

    // ── Test 2: authLensStream emits on token/claims change when previousUid == newUid ──

    @Test("Verify authLensStream emits on token/claims change when previousUid == newUid")
    func testAuthLensStreamEmitsOnClaimsChangeWithSameUid() async throws {
        let (channel, _, _, auth) = try await createHarness()

        var lensIterator = auth.authLensStream.makeAsyncIterator()

        // 1. Initial lens is anon
        let initialLens = await lensIterator.next()
        #expect(initialLens == .anon)

        // 2. Sign in as user-alice (no claims initially)
        let signInTask = Task {
            try await auth.signIn(withEmail: "alice@example.com", password: "password123")
        }
        try await simulateSignInSuccess(channel: channel, uid: "user-alice")
        let user = try await signInTask.value.user

        let signedInLens = await lensIterator.next()
        #expect(signedInLens == .asUser(uid: "user-alice"))

        // 3. User refreshes token with custom claims: ["admin": true]
        let tokenResultTask1 = Task {
            try await user.getIDTokenResult(forcingRefresh: true)
        }
        let frame1 = try await channel.awaitNextSentMessage(timeoutSeconds: 2.0)
        let id1 = frame1["id"]?.stringValue ?? "rop-c1"
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": id1,
            "ok": true,
            "res": [
                "token": "jwt-token-admin",
                "claims": ["admin": true],
                "expirationTime": "2026-09-04T19:00:00.000Z",
                "authTime": "2026-09-04T17:00:00.000Z",
                "issuedAtTime": "2026-09-04T18:00:00.000Z",
                "signInProvider": "password"
            ]
        ])
        _ = try await tokenResultTask1.value

        // Crucial check: previousUid ("user-alice") == newUid ("user-alice"),
        // but token/claims changed, so authLensStream MUST emit the updated lens!
        let claimsLens1 = await lensIterator.next()
        #expect(claimsLens1 == .asUser(uid: "user-alice", token: ["admin": .bool(true)]))
        #expect(auth.currentAuthLens() == .asUser(uid: "user-alice", token: ["admin": .bool(true)]))

        // 4. User refreshes token with different custom claims: ["admin": false, "tier": "gold"]
        let tokenResultTask2 = Task {
            try await user.getIDTokenResult(forcingRefresh: true)
        }
        let frame2 = try await channel.awaitNextSentMessage(timeoutSeconds: 2.0)
        let id2 = frame2["id"]?.stringValue ?? "rop-c2"
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": id2,
            "ok": true,
            "res": [
                "token": "jwt-token-gold",
                "claims": ["admin": false, "tier": "gold"],
                "expirationTime": "2026-09-04T19:00:00.000Z",
                "authTime": "2026-09-04T17:00:00.000Z",
                "issuedAtTime": "2026-09-04T18:00:00.000Z",
                "signInProvider": "password"
            ]
        ])
        _ = try await tokenResultTask2.value

        let claimsLens2 = await lensIterator.next()
        #expect(claimsLens2 == .asUser(uid: "user-alice", token: ["admin": .bool(false), "tier": .string("gold")]))
        #expect(auth.currentAuthLens() == .asUser(uid: "user-alice", token: ["admin": .bool(false), "tier": .string("gold")]))

        // 5. Sign out -> emits anon
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

        let signedOutLens = await lensIterator.next()
        #expect(signedOutLens == .anon)
    }

    // ── Test 3: Snapshot Re-subscription on Token/Claims Change (same UID) ──

    @Test("Verify SnapshotSubscriptionCoordinator re-subscribes when claims change without UID change")
    func testSnapshotReSubscriptionOnClaimsChangeSameUid() async throws {
        let (channel, _, firestore, auth) = try await createHarness()

        let docRef = firestore.document("settings/security")
        let reg = docRef.addSnapshotListener { _, _ in }

        // 1. Initial subscription with mode: anon
        let initialSubFrame = try await channel.awaitNextSentMessage()
        #expect(initialSubFrame["type"]?.stringValue == "worker-sub")
        let initialSubPayload = initialSubFrame["sub"]?.dictionaryValue
        #expect(initialSubPayload?["actAs"]?.dictionaryValue?["mode"]?.stringValue == "anon")

        // 2. Sign in as user-alice
        let signInTask = Task {
            try await auth.signIn(withEmail: "alice@example.com", password: "password")
        }
        try await simulateSignInSuccess(channel: channel, uid: "user-alice")
        let user = try await signInTask.value.user

        // 3. Receive re-sub with mode: as, uid: user-alice
        var userSubFrame: [String: AnySendable]?
        for _ in 0..<5 {
            let frame = try await channel.awaitNextSentMessage(timeoutSeconds: 2.0)
            if frame["type"]?.stringValue == "worker-sub" {
                userSubFrame = frame
                break
            }
        }
        #expect(userSubFrame != nil)
        let userSubPayload = userSubFrame?["sub"]?.dictionaryValue
        #expect(userSubPayload?["actAs"]?.dictionaryValue?["mode"]?.stringValue == "as")
        #expect(userSubPayload?["actAs"]?.dictionaryValue?["uid"]?.stringValue == "user-alice")

        // 4. Force token refresh with claims: ["premium": true]
        let tokenResultTask = Task {
            try await user.getIDTokenResult(forcingRefresh: true)
        }
        let frameToken = try await channel.awaitNextSentMessage(timeoutSeconds: 2.0)
        let idToken = frameToken["id"]?.stringValue ?? "rop-token"
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": idToken,
            "ok": true,
            "res": [
                "token": "jwt-premium",
                "claims": ["premium": true],
                "expirationTime": "2026-09-04T19:00:00.000Z",
                "authTime": "2026-09-04T17:00:00.000Z",
                "issuedAtTime": "2026-09-04T18:00:00.000Z",
                "signInProvider": "password"
            ]
        ])
        _ = try await tokenResultTask.value

        // 5. Coordinator MUST receive the claims change, cancel the previous subscription,
        // and re-subscribe with actAs containing token: ["premium": true]
        var claimsSubFrame: [String: AnySendable]?
        for _ in 0..<5 {
            let frame = try await channel.awaitNextSentMessage(timeoutSeconds: 2.0)
            if frame["type"]?.stringValue == "worker-sub" {
                claimsSubFrame = frame
                break
            }
        }
        #expect(claimsSubFrame != nil)
        let claimsSubPayload = claimsSubFrame?["sub"]?.dictionaryValue
        let actAs = claimsSubPayload?["actAs"]?.dictionaryValue
        #expect(actAs?["mode"]?.stringValue == "as")
        #expect(actAs?["uid"]?.stringValue == "user-alice")
        let tokenMap = actAs?["token"]?.dictionaryValue
        #expect(tokenMap?["premium"]?.boolValue == true)

        reg.remove()
    }

    // ── Test 4: Remote Sync Subscribes to Both authState and idToken ─────────

    @Test("Verify startRemoteSync subscribes to both authState and idToken channels")
    func testStartRemoteSyncDualChannels() async throws {
        let (channel, _, _, auth) = try await createHarness()

        auth.startRemoteSync()

        var subscribedTargets = Set<String>()
        for _ in 0..<2 {
            let frame = try await channel.awaitNextSentMessage(timeoutSeconds: 2.0)
            #expect(frame["type"]?.stringValue == "worker-sub")
            if let target = frame["sub"]?.dictionaryValue?["target"]?.stringValue {
                subscribedTargets.insert(target)
            }
        }

        #expect(subscribedTargets.contains("authState"))
        #expect(subscribedTargets.contains("idToken"))
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
