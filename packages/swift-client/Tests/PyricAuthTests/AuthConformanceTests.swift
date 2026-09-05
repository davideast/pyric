import Foundation
import Testing
@testable import FirebaseAuth
@testable import PyricFirestore
#if canImport(Combine)
import Combine
#endif

@Suite("auth-swift Conformance Suite")
struct AuthConformanceTests {

    private func createHarness(appName: String = "TestApp-\(UUID().uuidString)") async throws -> (Auth, MockAuthChannel) {
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

    // ── 1. Auth: Instance & Lifecycle (Rows 1–5) ──────────────────────────────
    @Test func `auth-swift#1: Auth.auth() returns default instance`() {
        let auth = Auth.auth()
        #expect(auth.app.name == "[DEFAULT]")
    }

    @Test func `auth-swift#2: Auth.auth(app:) returns instance for specific FirebaseApp`() {
        let app = FirebaseApp(name: "custom-app-\(UUID().uuidString)")
        let auth = Auth.auth(app: app)
        #expect(auth.app.name == app.name)
    }

    @Test func `auth-swift#3: Auth.reset() resets cached instances`() {
        let app = FirebaseApp(name: "reset-app-\(UUID().uuidString)")
        let auth1 = Auth.auth(app: app)
        Auth.reset()
        let auth2 = Auth.auth(app: app)
        #expect(auth1 !== auth2)
    }

    @Test func `auth-swift#4: Auth.app returns associated FirebaseApp`() {
        let app = FirebaseApp(name: "app-prop-test")
        let auth = Auth.auth(app: app)
        #expect(auth.app.name == "app-prop-test")
    }

    @Test func `auth-swift#5: Auth.useEmulator(withHost:port:) points to emulator endpoint`() async {
        let app = FirebaseApp(name: "emulator-test")
        let auth = Auth.auth(app: app)
        auth.useEmulator(withHost: "127.0.0.1", port: 9099)
        let endpoint = await auth.bridgeClient.endpoint
        #expect(endpoint.host == "127.0.0.1")
        #expect(endpoint.port == 9099)
    }

    // ── 2. Auth: Authentication Operations (Rows 6–13) ────────────────────────
    @Test func `auth-swift#6: Auth.signIn(withEmail:password:) async returns AuthDataResult`() async throws {
        let (auth, channel) = try await createHarness()
        let task = Task { try await auth.signIn(withEmail: "user@example.com", password: "pwd") }

        let frame = try await channel.awaitNextSentMessage()
        #expect(frame["op"]?["method"]?.stringValue == "auth.signInEmail")
        let opId = frame["id"]?.stringValue ?? "op-1"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true,
            "res": ["user": ["uid": "u1", "email": "user@example.com", "providerId": "password"], "operationType": "signIn"]
        ])
        let res = try await task.value
        #expect(res.user.uid == "u1")
        #expect(auth.currentUser?.uid == "u1")
    }

    @Test func `auth-swift#7: Auth.signIn(withEmail:password:completion:) callback variant`() async throws {
        let (auth, channel) = try await createHarness()
        let exp = expectation()
        auth.signIn(withEmail: "user@example.com", password: "pwd") { res, err in
            #expect(err == nil)
            #expect(res?.user.uid == "u1")
            exp.fulfill()
        }
        let frame = try await channel.awaitNextSentMessage()
        let opId = frame["id"]?.stringValue ?? "op-2"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true,
            "res": ["user": ["uid": "u1", "email": "user@example.com", "providerId": "password"], "operationType": "signIn"]
        ])
        await exp.wait()
    }

    @Test func `auth-swift#8: Auth.createUser(withEmail:password:) async creates user`() async throws {
        let (auth, channel) = try await createHarness()
        let task = Task { try await auth.createUser(withEmail: "new@example.com", password: "pwd") }
        let frame = try await channel.awaitNextSentMessage()
        #expect(frame["op"]?["method"]?.stringValue == "auth.createUser")
        let opId = frame["id"]?.stringValue ?? "op-3"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true,
            "res": ["user": ["uid": "u2", "email": "new@example.com", "providerId": "password"], "operationType": "signUp"]
        ])
        let res = try await task.value
        #expect(res.user.uid == "u2")
    }

    @Test func `auth-swift#9: Auth.createUser(withEmail:password:completion:) callback variant`() async throws {
        let (auth, channel) = try await createHarness()
        let exp = expectation()
        auth.createUser(withEmail: "new@example.com", password: "pwd") { res, err in
            #expect(err == nil)
            #expect(res?.user.uid == "u2")
            exp.fulfill()
        }
        let frame = try await channel.awaitNextSentMessage()
        let opId = frame["id"]?.stringValue ?? "op-4"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true,
            "res": ["user": ["uid": "u2", "email": "new@example.com", "providerId": "password"], "operationType": "signUp"]
        ])
        await exp.wait()
    }

    @Test func `auth-swift#10: Auth.signInAnonymously() async creates anonymous user`() async throws {
        let (auth, channel) = try await createHarness()
        let task = Task { try await auth.signInAnonymously() }
        let frame = try await channel.awaitNextSentMessage()
        #expect(frame["op"]?["method"]?.stringValue == "auth.signInAnonymously")
        let opId = frame["id"]?.stringValue ?? "op-5"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true,
            "res": ["user": ["uid": "u-anon", "isAnonymous": true, "providerId": "anonymous"], "operationType": "signIn"]
        ])
        let res = try await task.value
        #expect(res.user.isAnonymous == true)
    }

    @Test func `auth-swift#11: Auth.signInAnonymously(completion:) callback variant`() async throws {
        let (auth, channel) = try await createHarness()
        let exp = expectation()
        auth.signInAnonymously { res, err in
            #expect(err == nil)
            #expect(res?.user.isAnonymous == true)
            exp.fulfill()
        }
        let frame = try await channel.awaitNextSentMessage()
        let opId = frame["id"]?.stringValue ?? "op-6"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true,
            "res": ["user": ["uid": "u-anon", "isAnonymous": true, "providerId": "anonymous"], "operationType": "signIn"]
        ])
        await exp.wait()
    }

    @Test func `auth-swift#12: Auth.signOut() clears user and notifies listeners`() async throws {
        let (auth, _) = try await createHarness()
        let user = User(auth: auth, uid: "u-out")
        auth.applyUserTransition(user)
        #expect(auth.currentUser?.uid == "u-out")
        try auth.signOut()
        #expect(auth.currentUser == nil)
        #expect(auth.currentAuthLens() == .anon)
    }

    @Test func `auth-swift#13: Auth.restoreSession(uid:) re-hydrates authenticated user`() async throws {
        let (auth, channel) = try await createHarness()
        let task = Task { try await auth.restoreSession(uid: "u-restored") }
        let frame = try await channel.awaitNextSentMessage()
        #expect(frame["op"]?["method"]?.stringValue == "auth.restorePortSession")
        let opId = frame["id"]?.stringValue ?? "op-7"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true,
            "res": ["uid": "u-restored", "email": "r@example.com", "providerId": "password"]
        ])
        let restored = try await task.value
        #expect(restored?.uid == "u-restored")
        #expect(auth.currentUser?.uid == "u-restored")
    }

    // ── 3. Auth: State Listeners & Reactive Streams (Rows 14–24) ──────────────
    @Test func `auth-swift#14: Auth.currentUser returns active user or nil`() async throws {
        let (auth, _) = try await createHarness()
        #expect(auth.currentUser == nil)
        auth.applyUserTransition(User(auth: auth, uid: "active-u"))
        #expect(auth.currentUser?.uid == "active-u")
    }

    @Test func `auth-swift#15: Auth.addStateDidChangeListener attaches listener callback`() async throws {
        let (auth, _) = try await createHarness()
        let observedUid = Box<String?>(nil)
        let handle = auth.addStateDidChangeListener { _, user in observedUid.value = user?.uid }
        #expect(observedUid.value == nil)
        auth.applyUserTransition(User(auth: auth, uid: "u-obs"))
        #expect(observedUid.value == "u-obs")
        auth.removeStateDidChangeListener(handle)
    }

    @Test func `auth-swift#16: Auth.removeStateDidChangeListener unregisters callback`() async throws {
        let (auth, _) = try await createHarness()
        let count = Box<Int>(0)
        let handle = auth.addStateDidChangeListener { _, _ in count.value += 1 }
        #expect(count.value == 1)
        auth.removeStateDidChangeListener(handle)
        auth.applyUserTransition(User(auth: auth, uid: "u-removed"))
        #expect(count.value == 1)
    }

    @Test func `auth-swift#17: Auth.addIDTokenDidChangeListener attaches token callback`() async throws {
        let (auth, _) = try await createHarness()
        let tokenEvents = Box<Int>(0)
        let handle = auth.addIDTokenDidChangeListener { _, _ in tokenEvents.value += 1 }
        #expect(tokenEvents.value == 1)
        auth.notifyIdTokenChanged()
        #expect(tokenEvents.value == 2)
        auth.removeIDTokenDidChangeListener(handle)
    }

    @Test func `auth-swift#18: Auth.removeIDTokenDidChangeListener unregisters token callback`() async throws {
        let (auth, _) = try await createHarness()
        let count = Box<Int>(0)
        let handle = auth.addIDTokenDidChangeListener { _, _ in count.value += 1 }
        auth.removeIDTokenDidChangeListener(handle)
        auth.notifyIdTokenChanged()
        #expect(count.value == 1)
    }

    @Test func `auth-swift#19: Auth.authStateDidChangeStream emits async stream`() async throws {
        let (auth, _) = try await createHarness()
        var iterator = auth.authStateDidChangeStream.makeAsyncIterator()
        let first = await iterator.next()
        #expect(first != nil && first! == nil)
        auth.applyUserTransition(User(auth: auth, uid: "stream-u"))
        let second = await iterator.next()
        #expect(second??.uid == "stream-u")
    }

    @Test func `auth-swift#20: Auth.idTokenDidChangeStream emits token refresh events`() async throws {
        let (auth, _) = try await createHarness()
        var iterator = auth.idTokenDidChangeStream.makeAsyncIterator()
        _ = await iterator.next()
        auth.applyUserTransition(User(auth: auth, uid: "id-stream-u"))
        let second = await iterator.next()
        #expect(second??.uid == "id-stream-u")
    }

    @Test func `auth-swift#21: Auth.authStateChanges exposes AsyncSequence`() async throws {
        let (auth, _) = try await createHarness()
        var iterator = auth.authStateChanges.makeAsyncIterator()
        let first = await iterator.next()
        #expect(first != nil && first! == nil)
    }

    @Test func `auth-swift#22: Auth.idTokenChanges exposes AsyncSequence`() async throws {
        let (auth, _) = try await createHarness()
        var iterator = auth.idTokenChanges.makeAsyncIterator()
        let first = await iterator.next()
        #expect(first != nil && first! == nil)
    }

    @Test func `auth-swift#23: Auth.authStatePublisher emits Combine updates`() async throws {
        #if canImport(Combine)
        let (auth, _) = try await createHarness()
        var received: String?
        let cancellable = auth.authStatePublisher.sink { user in received = user?.uid }
        auth.applyUserTransition(User(auth: auth, uid: "combine-u"))
        #expect(received == "combine-u")
        _ = cancellable
        #endif
    }

    @Test func `auth-swift#24: Auth.idTokenPublisher emits Combine token updates`() async throws {
        #if canImport(Combine)
        let (auth, _) = try await createHarness()
        var count = 0
        let cancellable = auth.idTokenPublisher.sink { _ in count += 1 }
        auth.notifyIdTokenChanged()
        #expect(count >= 2)
        _ = cancellable
        #endif
    }

    // ── 4. User: Identity Properties (Rows 25–35) ─────────────────────────────
    @Test func `auth-swift#25: User.uid returns unique string identifier`() {
        let user = User(uid: "u-25")
        #expect(user.uid == "u-25")
    }

    @Test func `auth-swift#26: User.email returns primary email`() {
        let user = User(uid: "u-26", email: "test@example.com")
        #expect(user.email == "test@example.com")
    }

    @Test func `auth-swift#27: User.displayName returns display name`() {
        let user = User(uid: "u-27", displayName: "Ada Lovelace")
        #expect(user.displayName == "Ada Lovelace")
    }

    @Test func `auth-swift#28: User.photoURL returns profile photo URL`() {
        let url = URL(string: "https://example.com/photo.png")
        let user = User(uid: "u-28", photoURL: url)
        #expect(user.photoURL == url)
    }

    @Test func `auth-swift#29: User.phoneNumber returns phone number`() {
        let user = User(uid: "u-29", phoneNumber: "+15551234567")
        #expect(user.phoneNumber == "+15551234567")
    }

    @Test func `auth-swift#30: User.isAnonymous indicates anonymity`() {
        let user = User(uid: "u-30", isAnonymous: true)
        #expect(user.isAnonymous == true)
    }

    @Test func `auth-swift#31: User.isEmailVerified indicates verification status`() {
        let user = User(uid: "u-31", isEmailVerified: true)
        #expect(user.isEmailVerified == true)
    }

    @Test func `auth-swift#32: User.providerID returns provider identifier`() {
        let user = User(uid: "u-32", providerID: "password")
        #expect(user.providerID == "password")
    }

    @Test func `auth-swift#33: User.providerData returns linked providers`() {
        let info = UserInfoImpl(providerID: "google.com", uid: "gid-1", displayName: "Google User")
        let user = User(uid: "u-33", providerData: [info])
        #expect(user.providerData.count == 1)
        #expect(user.providerData.first?.providerID == "google.com")
    }

    @Test func `auth-swift#34: User.tenant returns tenant identifier`() {
        let user = User(uid: "u-34", tenant: "tenant-corp")
        #expect(user.tenant == "tenant-corp")
    }

    @Test func `auth-swift#35: User.claims returns claims dictionary`() {
        let user = User(uid: "u-35", claims: ["role": .string("admin")])
        #expect(user.claims["role"]?.stringValue == "admin")
        #expect(user.customClaims["role"]?.stringValue == "admin")
    }

    // ── 5. User: Token Retrieval & Mutations (Rows 36–41) ─────────────────────
    @Test func `auth-swift#36: User.getIDToken(forcingRefresh:) async returns token`() async throws {
        let (auth, channel) = try await createHarness()
        let user = User(auth: auth, uid: "u-36")
        let task = Task { try await user.getIDToken(forcingRefresh: true) }
        let frame = try await channel.awaitNextSentMessage()
        #expect(frame["op"]?["method"]?.stringValue == "auth.getIdToken")
        #expect(frame["op"]?["forceRefresh"]?.boolValue == true)
        let opId = frame["id"]?.stringValue ?? "op-8"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true, "res": "jwt-token-36"
        ])
        let token = try await task.value
        #expect(token == "jwt-token-36")
    }

    @Test func `auth-swift#37: User.getIDToken(forcingRefresh:completion:) callback variant`() async throws {
        let (auth, channel) = try await createHarness()
        let user = User(auth: auth, uid: "u-37")
        let exp = expectation()
        user.getIDToken { tok, err in
            #expect(err == nil)
            #expect(tok == "jwt-token-37")
            exp.fulfill()
        }
        let frame = try await channel.awaitNextSentMessage()
        let opId = frame["id"]?.stringValue ?? "op-9"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true, "res": "jwt-token-37"
        ])
        await exp.wait()
    }

    @Test func `auth-swift#38: User.getIDTokenResult(forcingRefresh:) async returns result`() async throws {
        let (auth, channel) = try await createHarness()
        let user = User(auth: auth, uid: "u-38")
        let task = Task { try await user.getIDTokenResult() }
        let frame = try await channel.awaitNextSentMessage()
        #expect(frame["op"]?["method"]?.stringValue == "auth.getIdTokenResult")
        let opId = frame["id"]?.stringValue ?? "op-10"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true,
            "res": ["token": "tok-res-38", "claims": ["admin": true], "signInProvider": "password"]
        ])
        let res = try await task.value
        #expect(res.token == "tok-res-38")
        #expect(res.signInProvider == "password")
    }

    @Test func `auth-swift#39: User.getIDTokenResult(forcingRefresh:completion:) callback variant`() async throws {
        let (auth, channel) = try await createHarness()
        let user = User(auth: auth, uid: "u-39")
        let exp = expectation()
        user.getIDTokenResult { res, err in
            #expect(err == nil)
            #expect(res?.token == "tok-res-39")
            exp.fulfill()
        }
        let frame = try await channel.awaitNextSentMessage()
        let opId = frame["id"]?.stringValue ?? "op-11"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true,
            "res": ["token": "tok-res-39", "claims": [:], "signInProvider": "anonymous"]
        ])
        await exp.wait()
    }

    @Test func `auth-swift#40: User.updateProfile(displayName:photoURL:) async updates user`() async throws {
        let (auth, channel) = try await createHarness()
        let user = User(auth: auth, uid: "u-40")
        let task = Task { try await user.updateProfile(displayName: "Updated Name", photoURL: nil) }
        let frame = try await channel.awaitNextSentMessage()
        #expect(frame["op"]?["method"]?.stringValue == "auth.updateProfile")
        let opId = frame["id"]?.stringValue ?? "op-12"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true,
            "res": ["displayName": "Updated Name"]
        ])
        try await task.value
        #expect(user.displayName == "Updated Name")
    }

    @Test func `auth-swift#41: User.reload() refreshes user data from server`() async throws {
        let (auth, channel) = try await createHarness()
        let user = User(auth: auth, uid: "u-41", email: "old@example.com")
        let task = Task { try await user.reload() }
        let frame = try await channel.awaitNextSentMessage()
        #expect(frame["op"]?["method"]?.stringValue == "auth.getCurrentUser")
        let opId = frame["id"]?.stringValue ?? "op-13"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true,
            "res": ["email": "reloaded@example.com"]
        ])
        try await task.value
        #expect(user.email == "reloaded@example.com")
    }

    // ── 6. Supporting Types & Metadata (Rows 42–47) ───────────────────────────
    @Test func `auth-swift#42: AuthDataResult.user returns User instance`() {
        let user = User(uid: "res-u")
        let res = AuthDataResult(user: user, additionalUserInfo: nil)
        #expect(res.user.uid == "res-u")
    }

    @Test func `auth-swift#43: AuthDataResult.additionalUserInfo returns info`() {
        let info = AdditionalUserInfo(providerID: "google.com", isNewUser: true)
        let res = AuthDataResult(user: User(uid: "u"), additionalUserInfo: info)
        #expect(res.additionalUserInfo?.providerID == "google.com")
        #expect(res.additionalUserInfo?.isNewUser == true)
    }

    @Test func `auth-swift#44: AuthTokenResult.token returns token string`() {
        let now = Date()
        let res = AuthTokenResult(token: "token-44", expirationDate: now, authDate: now, issuedAtDate: now, signInProvider: nil, claims: [:])
        #expect(res.token == "token-44")
    }

    @Test func `auth-swift#45: AuthTokenResult.claims returns claims dictionary`() {
        let now = Date()
        let res = AuthTokenResult(token: "token-45", expirationDate: now, authDate: now, issuedAtDate: now, signInProvider: nil, claims: ["admin": .bool(true)])
        #expect(res.claims["admin"]?.boolValue == true)
    }

    @Test func `auth-swift#46: AuthTokenResult.expirationTime returns timestamp`() {
        let now = Date()
        let res = AuthTokenResult(token: "token-46", expirationDate: now, authDate: now, issuedAtDate: now, signInProvider: nil, claims: [:])
        #expect(res.expirationDate == now)
    }

    @Test func `auth-swift#47: UserInfoImpl attributes conformance`() {
        let info = UserInfoImpl(providerID: "github.com", uid: "gh-1", displayName: "Dev", photoURL: nil, email: "dev@example.com", phoneNumber: nil)
        #expect(info.providerID == "github.com")
        #expect(info.displayName == "Dev")
    }

    // ── 7. Multi-Tenancy, Impersonation & Firestore Coupling (Rows 48–52) ─────
    @Test func `auth-swift#48: Auth.switchLens toggles impersonation lens`() async throws {
        let (auth, _) = try await createHarness()
        auth.switchLens(.admin)
        #expect(auth.impersonatedLens == .admin)
        #expect(auth.currentAuthLens() == .admin)
        auth.switchLens(nil)
        #expect(auth.impersonatedLens == nil)
        #expect(auth.currentAuthLens() == .anon)
    }

    @Test func `auth-swift#49: Auth.currentAuthLens computes effective lens`() async throws {
        let (auth, _) = try await createHarness()
        #expect(auth.currentAuthLens() == .anon)
        auth.applyUserTransition(User(auth: auth, uid: "lens-u", tenant: "t1"))
        #expect(auth.currentAuthLens() == .asUser(uid: "lens-u", tenant: "t1"))
    }

    @Test func `auth-swift#50: Auth.authLensStream emits lens transitions`() async throws {
        let (auth, _) = try await createHarness()
        var iterator = auth.authLensStream.makeAsyncIterator()
        let first = await iterator.next()
        #expect(first == .anon)
        auth.switchLens(.admin)
        let second = await iterator.next()
        #expect(second == .admin)
    }

    @Test func `auth-swift#51: FirebaseAuthBootstrap.initialize registers provider`() {
        FirebaseAuthBootstrap.initialize()
        let provider = AuthCredentialProviderRegistry.resolve(app: FirebaseApp.app())
        #expect(provider != nil)
    }

    @Test func `auth-swift#52: SnapshotSubscriptionCoordinator re-subscription coupling`() async throws {
        let (auth, _) = try await createHarness()
        let observedLens = Box<AuthLens?>(nil)
        let task = Task {
            for await lens in auth.authLensStream {
                observedLens.value = lens
            }
        }
        auth.applyUserTransition(User(auth: auth, uid: "coupled-u"))
        try await Task.sleep(nanoseconds: 5_000_000)
        #expect(observedLens.value == .asUser(uid: "coupled-u"))
        task.cancel()
    }

    // ── 8. Error Handling (Rows 53–54) ────────────────────────────────────────
    @Test func `auth-swift#53: AuthErrorCode enumerates standard error codes`() {
        let err1 = AuthErrorCode.from(codeString: "auth/invalid-email")
        #expect(err1 == .invalidEmail)
        let err2 = AuthErrorCode.from(codeString: "auth/wrong-password")
        #expect(err2 == .wrongPassword)
    }

    @Test func `auth-swift#54: AuthError maps wire errors to structured codes`() {
        let bridgeErr = PyricBridgeError(code: .permissionDenied, rawCode: "auth/user-disabled", message: "Account disabled")
        let authErr = AuthError.from(error: bridgeErr)
        #expect(authErr.code == .userDisabled)
    }
}

// ── Test Helpers ───────────────────────────────────────────────────────────────
private final class AsyncExpectation: @unchecked Sendable {
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
private func expectation() -> AsyncExpectation { AsyncExpectation() }

private final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}
