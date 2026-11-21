import Foundation
import Testing
@testable import FirebaseAuth
@testable import PyricFirestore

extension AuthConformanceTests {

    func createHarness(appName: String = "TestApp-\(UUID().uuidString)") async throws -> (Auth, MockAuthChannel) {
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

    @Test func `Auth.signIn(withCustomToken:) async and completion variants dispatch auth.signInWithCustomToken`() async throws {
        let (auth, channel) = try await createHarness()
        let task = Task { try await auth.signIn(withCustomToken: "custom-jwt-1") }
        let frame = try await channel.awaitNextSentMessage()
        #expect(frame["op"]?["method"]?.stringValue == "auth.signInWithCustomToken")
        #expect(frame["op"]?["customToken"]?.stringValue == "custom-jwt-1")
        let opId = frame["id"]?.stringValue ?? "op-ct-1"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": opId, "ok": true,
            "res": ["user": ["uid": "u-custom-1", "isAnonymous": false, "providerId": "firebase"], "operationType": "signIn"]
        ])
        let res = try await task.value
        #expect(res.user.uid == "u-custom-1")
        #expect(auth.currentUser?.uid == "u-custom-1")

        let exp = expectation()
        auth.signIn(withCustomToken: "custom-jwt-2") { cbRes, cbErr in
            #expect(cbErr == nil)
            #expect(cbRes?.user.uid == "u-custom-2")
            exp.fulfill()
        }
        let cbFrame = try await channel.awaitNextSentMessage()
        #expect(cbFrame["op"]?["method"]?.stringValue == "auth.signInWithCustomToken")
        let cbId = cbFrame["id"]?.stringValue ?? "op-ct-2"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": cbId, "ok": true,
            "res": ["user": ["uid": "u-custom-2", "isAnonymous": false, "providerId": "firebase"], "operationType": "signIn"]
        ])
        await exp.wait()
    }

    @Test func `User.getIDTokenForcingRefresh async and completion overloads forward forceRefresh`() async throws {
        let (auth, channel) = try await createHarness()
        let user = User(auth: auth, uid: "u-37-objc")

        let asyncTask = Task { try await user.getIDTokenForcingRefresh(true) }
        let asyncFrame = try await channel.awaitNextSentMessage()
        #expect(asyncFrame["op"]?["method"]?.stringValue == "auth.getIdToken")
        #expect(asyncFrame["op"]?["forceRefresh"]?.boolValue == true)
        let asyncOpId = asyncFrame["id"]?.stringValue ?? "op-objc-1"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": asyncOpId, "ok": true, "res": "jwt-objc-async"
        ])
        #expect(try await asyncTask.value == "jwt-objc-async")

        let exp = expectation()
        user.getIDTokenForcingRefresh(false) { tok, err in
            #expect(err == nil)
            #expect(tok == "jwt-objc-cb")
            exp.fulfill()
        }
        let cbFrame = try await channel.awaitNextSentMessage()
        #expect(cbFrame["op"]?["method"]?.stringValue == "auth.getIdToken")
        #expect(cbFrame["op"]?["forceRefresh"]?.boolValue == false)
        let cbOpId = cbFrame["id"]?.stringValue ?? "op-objc-2"
        try channel.simulateServerMessage([
            "type": "worker-res", "id": cbOpId, "ok": true, "res": "jwt-objc-cb"
        ])
        await exp.wait()
    }
}

final class AsyncExpectation: @unchecked Sendable {
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

func expectation() -> AsyncExpectation { AsyncExpectation() }

final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}
