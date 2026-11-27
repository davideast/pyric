import Foundation
import Testing
@testable import PyricAppCheck
@testable import PyricFirestore

private final class StubAppCheckChannel: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var incoming: [String] = []
    private var waiters: [CheckedContinuation<String, Error>] = []
    private var closed = false
    var sentFrames: [[String: Any]] = []
    private let handler: @Sendable ([String: Any], StubAppCheckChannel) -> Void

    init(handler: @escaping @Sendable ([String: Any], StubAppCheckChannel) -> Void) {
        self.handler = handler
    }

    func pushServer(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8) else { return }
        lock.lock()
        if !waiters.isEmpty {
            let cont = waiters.removeFirst()
            lock.unlock()
            cont.resume(returning: text)
            return
        }
        incoming.append(text)
        lock.unlock()
    }

    func send(_ text: String) async throws {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        lock.withLock { sentFrames.append(obj) }
        handler(obj, self)
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            lock.lock()
            if !incoming.isEmpty {
                let first = incoming.removeFirst()
                lock.unlock()
                cont.resume(returning: first)
                return
            }
            if closed {
                lock.unlock()
                cont.resume(throwing: URLError(.cancelled))
                return
            }
            waiters.append(cont)
            lock.unlock()
        }
    }

    func close(closeCode: Int, reason: String?) async {
        let pending: [CheckedContinuation<String, Error>] = lock.withLock {
            closed = true
            let snapshot = waiters
            waiters.removeAll()
            return snapshot
        }
        for w in pending { w.resume(throwing: URLError(.cancelled)) }
    }
}

private final class GateProvider: AppCheckProvider, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var firstCont: CheckedContinuation<AppCheckToken, Error>?

    func releaseFirst(_ token: AppCheckToken) {
        lock.lock()
        let c = firstCont
        firstCont = nil
        lock.unlock()
        c?.resume(returning: token)
    }

    func getToken(completion handler: @escaping @Sendable (AppCheckToken?, Error?) -> Void) {
        Task {
            do {
                handler(try await self.getToken(), nil)
            } catch {
                handler(nil, error)
            }
        }
    }

    func getToken() async throws -> AppCheckToken {
        let idx: Int = lock.withLock {
            count += 1
            return count
        }
        if idx == 1 {
            return try await withCheckedThrowingContinuation { cont in
                lock.lock()
                firstCont = cont
                lock.unlock()
            }
        }
        return AppCheckToken(token: "tok-fresh", expirationDate: Date.distantFuture)
    }
}

private final class GateProviderFactory: AppCheckProviderFactory, @unchecked Sendable {
    let provider: GateProvider
    init(_ provider: GateProvider) { self.provider = provider }
    func createProvider(with app: FirebaseApp) -> (any AppCheckProvider)? { provider }
}

@Suite("PyricAppCheck Phase 2 Parity Regression Suite")
struct AppCheckPhase2RegressionTests {
    @Test("P2-S12a/b/c: auto-attaches appCheckToken on ops/subs/HTTP headers, guards stale mint, and clamps distantFuture refresh")
    func appCheckAutoAttachAndGenerationGuard() async throws {
        try await FirebaseGlobalTestGate.shared.withExclusiveAccess {
            let channel = StubAppCheckChannel { frame, ch in
                let type = frame["type"] as? String
                if type == "attach" {
                    ch.pushServer([
                        "type": "attach-ack",
                        "protocol": 1,
                        "peerConnected": true,
                        "clientSessionId": "sess-ac-p2",
                    ])
                } else if type == "worker-op", let id = frame["id"] as? String {
                    ch.pushServer(["type": "worker-res", "id": id, "ok": true, "value": [:]])
                }
            }
            let client = PyricBridgeClient(channel: channel)
            try await client.connect()
            let app = FirebaseApp(name: "ac-p2-\(UUID().uuidString)")
            let provider = GateProvider()
            let appCheck = AppCheck.createForTesting(
                app: app,
                providerFactory: GateProviderFactory(provider),
                bridgeClient: client,
                isTokenAutoRefreshEnabled: true
            )

            let slowTask = Task { try await appCheck.token(forcingRefresh: false) }
            try await Task.sleep(nanoseconds: 25_000_000)

            // Forced mint returns Date.distantFuture (must not trap in scheduleAutoRefreshLocked).
            let forced = try await appCheck.token(forcingRefresh: true)
            #expect(forced.token == "tok-fresh")

            provider.releaseFirst(AppCheckToken(token: "tok-stale", expirationDate: Date().addingTimeInterval(600)))
            let slowRes = try await slowTask.value
            #expect(slowRes.token == "tok-stale")
            #expect((try await appCheck.token(forcingRefresh: false)).token == "tok-fresh")

            _ = try await client.op(method: "firestore.get", params: ["path": .string("items/1")])
            let opFrame = channel.sentFrames.last { ($0["op"] as? [String: Any])?["method"] as? String == "firestore.get" }
            #expect((opFrame?["op"] as? [String: Any])?["appCheckToken"] as? String == "tok-fresh")

            let headers = await BridgeAppCheckAttachment.attachHeader(
                to: ["Content-Length": "0"],
                tokenProvider: client.appCheckTokenProvider
            )
            #expect(headers["X-Firebase-AppCheck"] == "tok-fresh")
            await client.disconnect()
        }
    }
}
