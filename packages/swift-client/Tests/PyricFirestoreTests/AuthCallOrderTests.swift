import Foundation
import Testing
@testable import PyricFirestore
@testable import FirebaseAuth

// D1 (ADR-0019), across services: every Auth and User call that sends takes
// its place in call order on the client it shares with Firestore. Each test
// makes a Firestore completion-block write, then the Auth call under test,
// with the client's admission order held by a `CallOrderGate`; the write must
// reach the bridge first.

private let callbackQueue = DispatchQueue(label: "auth-call-order.callbacks")

/// An Auth or User call made after the earlier write, and the method it sends.
struct AuthLaterCall: CustomTestStringConvertible, Sendable {
    let name: String
    let method: String
    let issue: @Sendable (Auth, User) -> Void

    var testDescription: String { name }
}

private func asyncCall(
    _ name: String,
    _ method: String,
    _ call: @escaping @Sendable (Auth, User) async throws -> Void
) -> AuthLaterCall {
    AuthLaterCall(name: name, method: method) { auth, user in
        Task { try? await call(auth, user) }
    }
}

private let credential = GoogleAuthProvider.credential(withIDToken: "id-token", accessToken: "access-token")

let authLaterCalls: [AuthLaterCall] = [
    asyncCall("await signIn(withEmail:password:)", "auth.signInEmail") { auth, _ in
        _ = try await auth.signIn(withEmail: "a@example.com", password: "pw")
    },
    AuthLaterCall(name: "signIn(withEmail:password:completion:)", method: "auth.signInEmail") { auth, _ in
        auth.signIn(withEmail: "a@example.com", password: "pw") { _, _ in }
    },
    asyncCall("await createUser(withEmail:password:)", "auth.createUser") { auth, _ in
        _ = try await auth.createUser(withEmail: "a@example.com", password: "pw")
    },
    AuthLaterCall(name: "createUser(withEmail:password:completion:)", method: "auth.createUser") { auth, _ in
        auth.createUser(withEmail: "a@example.com", password: "pw") { _, _ in }
    },
    asyncCall("await signInAnonymously()", "auth.signInAnonymously") { auth, _ in
        _ = try await auth.signInAnonymously()
    },
    AuthLaterCall(name: "signInAnonymously(completion:)", method: "auth.signInAnonymously") { auth, _ in
        auth.signInAnonymously { _, _ in }
    },
    asyncCall("await signIn(with:)", "auth.signInWithCredential") { auth, _ in
        _ = try await auth.signIn(with: credential)
    },
    AuthLaterCall(name: "signIn(with:completion:)", method: "auth.signInWithCredential") { auth, _ in
        auth.signIn(with: credential) { _, _ in }
    },
    AuthLaterCall(name: "signOut()", method: "auth.signOut") { auth, _ in
        try? auth.signOut()
    },
    asyncCall("await restoreSession(uid:)", "auth.restorePortSession") { auth, _ in
        _ = try await auth.restoreSession(uid: "u1")
    },
    asyncCall("await User.getIDToken()", "auth.getIdToken") { _, user in
        _ = try await user.getIDToken()
    },
    AuthLaterCall(name: "User.getIDToken(completion:)", method: "auth.getIdToken") { _, user in
        user.getIDToken { _, _ in }
    },
    asyncCall("await User.getIDTokenResult()", "auth.getIdTokenResult") { _, user in
        _ = try await user.getIDTokenResult()
    },
    AuthLaterCall(name: "User.getIDTokenResult(completion:)", method: "auth.getIdTokenResult") { _, user in
        user.getIDTokenResult { _, _ in }
    },
    asyncCall("await User.updateProfile(displayName:photoURL:)", "auth.updateProfile") { _, user in
        try await user.updateProfile(displayName: "Ada", photoURL: nil)
    },
    asyncCall("await User.reload()", "auth.getCurrentUser") { _, user in
        try await user.reload()
    },
]

@Suite("Auth call order")
struct AuthCallOrderTests {

    @Test("A Firestore completion-block write reaches the bridge before a later Auth call", arguments: authLaterCalls)
    func writeThenLaterCall(_ call: AuthLaterCall) async throws {
        let bridge = FakeReconnectBridge()
        let client = makeReconnectingClient(bridge)
        try await client.connect()
        let app = FirebaseApp(name: "auth-call-order-\(UUID().uuidString)")
        let db = Firestore(bridgeClient: client, app: app)
        db.settings.dispatchQueue = callbackQueue
        let auth = Auth(app: app, bridgeClient: client)
        let user = try #require(User.fromWire(auth: auth, wire: .dictionary(["uid": .string("u1")])))

        let gate = CallOrderGate(client)
        db.document("order/earlier").setData(["n": 1], completion: nil)
        call.issue(auth, user)
        try await gate.open(afterCalls: 2) { hasArrived(bridge, call.method) }

        try await until { hasArrived(bridge, "setDoc", path: "order/earlier") && hasArrived(bridge, call.method) }
        let earlier = try #require(arrival(bridge, "setDoc", path: "order/earlier"))
        let laterCall = try #require(arrival(bridge, call.method))
        #expect(earlier < laterCall, "\(call.name) reached the bridge before the write issued ahead of it")
        await client.disconnect()
    }
}
