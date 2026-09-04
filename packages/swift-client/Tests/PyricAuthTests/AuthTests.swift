import Foundation
import Testing
@testable import FirebaseAuth
@testable import PyricFirestore
#if canImport(Combine)
import Combine
#endif

@Suite("Pyric FirebaseAuth Test Suite")
struct AuthTests {

    private func createMockAuth(appName: String = "TestApp-\(UUID().uuidString)") async throws -> (Auth, MockAuthChannel) {
        let channel = MockAuthChannel()
        let client = PyricBridgeClient(channel: channel)
        let app = FirebaseApp(name: appName)
        let auth = Auth(app: app, bridgeClient: client)

        // Consume initial attach frame and respond with attach-ack
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

    // ── 1. Sign In & Create User ─────────────────────────────────────────────

    @Test("signIn(withEmail:password:) sends auth.signInEmail and populates currentUser")
    func testSignInEmail() async throws {
        let (auth, channel) = try await createMockAuth()

        let signInTask = Task {
            try await auth.signIn(withEmail: "user@example.com", password: "password123")
        }

        // Bridge client dispatches worker-op
        let frame = try await channel.awaitNextSentMessage()
        #expect(frame["type"]?.stringValue == "worker-op")
        guard let op = frame["op"]?.dictionaryValue else {
            Issue.record("Missing op payload")
            return
        }
        #expect(op["method"]?.stringValue == "auth.signInEmail")
        #expect(op["email"]?.stringValue == "user@example.com")
        #expect(op["password"]?.stringValue == "password123")

        let opId = frame["id"]?.stringValue ?? "rop-1"
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": opId,
            "ok": true,
            "res": [
                "user": [
                    "uid": "user-abc-123",
                    "email": "user@example.com",
                    "emailVerified": true,
                    "displayName": "Test User",
                    "isAnonymous": false,
                    "providerId": "password"
                ],
                "providerId": "password",
                "operationType": "signIn"
            ]
        ])

        let result = try await signInTask.value
        #expect(result.user.uid == "user-abc-123")
        #expect(result.user.email == "user@example.com")
        #expect(result.user.displayName == "Test User")
        #expect(result.user.isEmailVerified == true)
        #expect(result.user.isAnonymous == false)
        #expect(auth.currentUser?.uid == "user-abc-123")

        // Credential provider reflection
        #expect(auth.currentAuthLens() == .asUser(uid: "user-abc-123"))
    }

    @Test("createUser(withEmail:password:) sends auth.createUser")
    func testCreateUser() async throws {
        let (auth, channel) = try await createMockAuth()

        let createTask = Task {
            try await auth.createUser(withEmail: "new@example.com", password: "password123")
        }

        let frame = try await channel.awaitNextSentMessage()
        guard let op = frame["op"]?.dictionaryValue else {
            Issue.record("Missing op payload")
            return
        }
        #expect(op["method"]?.stringValue == "auth.createUser")
        #expect(op["email"]?.stringValue == "new@example.com")

        let opId = frame["id"]?.stringValue ?? "rop-1"
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": opId,
            "ok": true,
            "res": [
                "user": [
                    "uid": "new-uid-456",
                    "email": "new@example.com",
                    "isAnonymous": false
                ],
                "operationType": "signIn"
            ]
        ])

        let result = try await createTask.value
        #expect(result.user.uid == "new-uid-456")
        #expect(auth.currentUser?.uid == "new-uid-456")
    }

    @Test("signInAnonymously() sends auth.signInAnonymously")
    func testSignInAnonymously() async throws {
        let (auth, channel) = try await createMockAuth()

        let anonTask = Task {
            try await auth.signInAnonymously()
        }

        let frame = try await channel.awaitNextSentMessage()
        guard let op = frame["op"]?.dictionaryValue else {
            Issue.record("Missing op payload")
            return
        }
        #expect(op["method"]?.stringValue == "auth.signInAnonymously")

        let opId = frame["id"]?.stringValue ?? "rop-1"
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": opId,
            "ok": true,
            "res": [
                "user": [
                    "uid": "anon-uid-789",
                    "isAnonymous": true
                ],
                "operationType": "signIn"
            ]
        ])

        let result = try await anonTask.value
        #expect(result.user.uid == "anon-uid-789")
        #expect(result.user.isAnonymous == true)
        #expect(auth.currentUser?.isAnonymous == true)
    }

    @Test("signOut() clears currentUser and reverts AuthLens to anon")
    func testSignOut() async throws {
        let (auth, channel) = try await createMockAuth()

        auth.switchLens(nil)
        // Simulate sign in
        _ = try await simulateSignIn(auth: auth, channel: channel, uid: "user-to-signout")
        #expect(auth.currentUser?.uid == "user-to-signout")

        try auth.signOut()
        #expect(auth.currentUser == nil)
        #expect(auth.currentAuthLens() == .anon)
    }

    @Test("signOut() with active impersonation clears impersonatedLens and reverts AuthLens to anon")
    func testSignOutWithImpersonation() async throws {
        let (auth, _) = try await createMockAuth()

        auth.switchLens(.asUser(uid: "impersonated-user-123"))
        #expect(auth.impersonatedLens == .asUser(uid: "impersonated-user-123"))
        #expect(auth.currentAuthLens() == .asUser(uid: "impersonated-user-123"))

        try auth.signOut()
        #expect(auth.impersonatedLens == nil)
        #expect(auth.currentUser == nil)
        #expect(auth.currentAuthLens() == .anon)
    }

    // ── 2. Tokens & Profile ──────────────────────────────────────────────────

    @Test("User.getIDToken and User.getIDTokenResult")
    func testTokens() async throws {
        let (auth, channel) = try await createMockAuth()
        let user = try await simulateSignIn(auth: auth, channel: channel, uid: "token-user")

        // 1. getIDToken
        let tokenTask = Task {
            try await user.getIDToken(forcingRefresh: true)
        }
        let tokenFrame = try await channel.awaitNextSentMessage()
        let tokenOp = tokenFrame["op"]?.dictionaryValue
        #expect(tokenOp?["method"]?.stringValue == "auth.getIdToken")
        #expect(tokenOp?["forceRefresh"]?.boolValue == true)

        let tokenOpId = tokenFrame["id"]?.stringValue ?? "rop-1"
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": tokenOpId,
            "ok": true,
            "res": "jwt-token-string-xyz"
        ])
        let tokenString = try await tokenTask.value
        #expect(tokenString == "jwt-token-string-xyz")

        // 2. getIDTokenResult
        let resultTask = Task {
            try await user.getIDTokenResult()
        }
        let resultFrame = try await channel.awaitNextSentMessage()
        let resultOp = resultFrame["op"]?.dictionaryValue
        #expect(resultOp?["method"]?.stringValue == "auth.getIdTokenResult")

        let resultOpId = resultFrame["id"]?.stringValue ?? "rop-2"
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": resultOpId,
            "ok": true,
            "res": [
                "token": "jwt-token-string-xyz",
                "claims": [
                    "role": "admin",
                    "orgId": "org-42"
                ],
                "expirationTime": "2026-09-04T18:00:00.000Z",
                "authTime": "2026-09-04T17:00:00.000Z",
                "issuedAtTime": "2026-09-04T17:00:00.000Z",
                "signInProvider": "password"
            ]
        ])

        let tokenResult = try await resultTask.value
        #expect(tokenResult.token == "jwt-token-string-xyz")
        #expect(tokenResult.claims["role"]?.stringValue == "admin")
        #expect(tokenResult.claims["orgId"]?.stringValue == "org-42")
        #expect(tokenResult.signInProvider == "password")
        #expect(user.claims["role"]?.stringValue == "admin")
    }

    @Test("User.updateProfile and User.reload mutate User properties")
    func testProfileUpdate() async throws {
        let (auth, channel) = try await createMockAuth()
        let user = try await simulateSignIn(auth: auth, channel: channel, uid: "profile-user")

        let updateTask = Task {
            try await user.updateProfile(displayName: "Renamed User", photoURL: URL(string: "https://example.com/photo.png"))
        }

        let frame = try await channel.awaitNextSentMessage()
        let op = frame["op"]?.dictionaryValue
        #expect(op?["method"]?.stringValue == "auth.updateProfile")
        #expect(op?["displayName"]?.stringValue == "Renamed User")

        let opId = frame["id"]?.stringValue ?? "rop-1"
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": opId,
            "ok": true,
            "res": [
                "uid": "profile-user",
                "displayName": "Renamed User",
                "photoURL": "https://example.com/photo.png"
            ]
        ])

        try await updateTask.value
        #expect(user.displayName == "Renamed User")
        #expect(user.photoURL?.absoluteString == "https://example.com/photo.png")
    }

    // ── 3. Multi-Tenancy & Impersonation ─────────────────────────────────────

    @Test("switchLens toggles impersonation and emits through authLensStream")
    func testImpersonationAndMultiTenancy() async throws {
        let (auth, _) = try await createMockAuth()

        var iterator = auth.authLensStream.makeAsyncIterator()

        // Initial lens should be .anon
        let initial = await iterator.next()
        #expect(initial == .anon)
        #expect(auth.currentAuthLens() == .anon)

        // 1. Switch to Admin Bypass
        auth.switchLens(.admin)
        let admin = await iterator.next()
        #expect(admin == .admin)
        #expect(auth.currentAuthLens() == .admin)

        // 2. Switch to Multi-tenant impersonation
        let tenantLens = AuthLens.asUser(uid: "member-1", tenant: "tenant-acme", token: ["dept": .string("eng")])
        auth.switchLens(tenantLens)
        let tenant = await iterator.next()
        #expect(tenant == tenantLens)
        #expect(auth.currentAuthLens() == tenantLens)

        // 3. Clear impersonation
        auth.switchLens(nil)
        let cleared = await iterator.next()
        #expect(cleared == .anon)
        #expect(auth.currentAuthLens() == .anon)
    }

    // ── 4. Reactive Streams & Listeners ──────────────────────────────────────

    @Test("authStateDidChangeStream and addStateDidChangeListener trigger on auth transitions")
    func testAuthListenersAndStreams() async throws {
        let (auth, channel) = try await createMockAuth()

        let listenerRecorder = EventRecorder<String?>()
        let handle = auth.addStateDidChangeListener { _, user in
            listenerRecorder.record(user?.uid)
        }

        var iterator = auth.authStateDidChangeStream.makeAsyncIterator()

        // Initially nil
        let initial = await iterator.next()
        #expect(initial != nil && initial! == nil)
        #expect(listenerRecorder.events == [nil])

        // Sign in user
        _ = try await simulateSignIn(auth: auth, channel: channel, uid: "stream-user-1")
        let signedIn = await iterator.next()
        #expect(signedIn != nil && signedIn!?.uid == "stream-user-1")

        // Sign out
        try auth.signOut()
        let signedOut = await iterator.next()
        #expect(signedOut != nil && signedOut! == nil)

        #expect(listenerRecorder.events == [nil, "stream-user-1", nil])
        auth.removeStateDidChangeListener(handle)
    }

    #if canImport(Combine)
    @Test("authStatePublisher emits User updates")
    func testCombinePublisher() async throws {
        let (auth, channel) = try await createMockAuth()

        let publishRecorder = EventRecorder<String?>()
        let cancellable = auth.authStatePublisher.sink { user in
            publishRecorder.record(user?.uid)
        }

        _ = try await simulateSignIn(auth: auth, channel: channel, uid: "combine-user")
        try auth.signOut()

        #expect(publishRecorder.events == [nil, "combine-user", nil])
        cancellable.cancel()
    }
    #endif

    // ── 5. Error Code Mapping ────────────────────────────────────────────────

    @Test("AuthErrorCode maps standard and custom error strings")
    func testErrorMappings() {
        #expect(AuthErrorCode.from(codeString: "auth/invalid-email") == .invalidEmail)
        #expect(AuthErrorCode.from(codeString: "invalid-email") == .invalidEmail)
        #expect(AuthErrorCode.from(codeString: "auth/wrong-password") == .wrongPassword)
        #expect(AuthErrorCode.from(codeString: "auth/user-not-found") == .userNotFound)
        #expect(AuthErrorCode.from(codeString: "auth/user-disabled") == .userDisabled)
        #expect(AuthErrorCode.from(codeString: "auth/email-already-in-use") == .emailAlreadyInUse)
        #expect(AuthErrorCode.from(codeString: "auth/weak-password") == .weakPassword)
        #expect(AuthErrorCode.from(codeString: "auth/operation-not-allowed") == .operationNotAllowed)
        #expect(AuthErrorCode.from(codeString: "auth/requires-recent-login") == .requiresRecentLogin)
        #expect(AuthErrorCode.from(codeString: "auth/network-request-failed") == .networkError)
        #expect(AuthErrorCode.from(codeString: "unknown-code-xyz") == .internalError)

        let bridgeError = PyricBridgeError(code: .unauthenticated, rawCode: "auth/user-not-found", message: "User missing")
        let mapped = AuthError.from(error: bridgeError)
        #expect(mapped.code == .userNotFound)
        #expect(mapped.message == "User missing")
    }

    // ── Helper ───────────────────────────────────────────────────────────────

    private func simulateSignIn(auth: Auth, channel: MockAuthChannel, uid: String) async throws -> User {
        let signInTask = Task {
            try await auth.signIn(withEmail: "\(uid)@example.com", password: "pw")
        }
        let frame = try await channel.awaitNextSentMessage()
        let opId = frame["id"]?.stringValue ?? "rop-1"
        try channel.simulateServerMessage([
            "type": "worker-res",
            "id": opId,
            "ok": true,
            "res": [
                "user": [
                    "uid": uid,
                    "email": "\(uid)@example.com"
                ],
                "operationType": "signIn"
            ]
        ])
        let res = try await signInTask.value
        return res.user
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
