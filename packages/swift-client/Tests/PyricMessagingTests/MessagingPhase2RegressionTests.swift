import Foundation
import Testing
@testable import PyricFirestore
@testable import PyricMessaging

private final class StaleTokenDelegate: MessagingDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var _tokens: [String] = []
    var tokens: [String] { lock.withLock { _tokens } }
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        if let fcmToken { lock.withLock { _tokens.append(fcmToken) } }
    }
}

private final class StubMessagingTransport: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var incoming: [String] = []
    private var waiters: [CheckedContinuation<String, Error>] = []
    private var closed = false
    private let handler: @Sendable ([String: Any], StubMessagingTransport) -> Void

    init(handler: @escaping @Sendable ([String: Any], StubMessagingTransport) -> Void) {
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

@Suite("PyricMessaging Phase 2 Parity Regression Suite")
struct MessagingPhase2RegressionTests {
    @Test("P2-S09: stale getToken racing deleteToken does not update lastAnnouncedToken or notify delegate")
    func staleGetTokenDoesNotAnnounceAfterDelete() async throws {
        final class Box: @unchecked Sendable {
            let lock = NSLock()
            var getId: String?
            var failDelete = false
        }
        let box = Box()
        let transport = StubMessagingTransport { frame, ch in
            let type = frame["type"] as? String
            if type == "attach" {
                ch.pushServer([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "clientSessionId": "sess-msg-p2",
                ])
            } else if type == "worker-op", let id = frame["id"] as? String {
                let method = (frame["op"] as? [String: Any])?["method"] as? String
                if method == "messaging.getToken" {
                    box.lock.withLock { box.getId = id }
                } else if method == "messaging.deleteToken" {
                    let shouldFail = box.lock.withLock { box.failDelete }
                    if shouldFail {
                        ch.pushServer([
                            "type": "worker-res",
                            "id": id,
                            "ok": false,
                            "error": ["code": "unavailable", "message": "boom"],
                        ])
                    } else {
                        ch.pushServer(["type": "worker-res", "id": id, "ok": true, "value": [:]])
                    }
                }
            }
        }
        let app = FirebaseApp(name: "msg-p2-\(UUID().uuidString)")
        let messaging = Messaging(app: app, transport: transport)
        let delegate = StaleTokenDelegate()
        messaging.delegate = delegate

        let pending = Task { try await messaging.token() }
        for _ in 0..<50 where box.lock.withLock({ box.getId }) == nil {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        try await messaging.deleteToken()

        let getId = try #require(box.lock.withLock { box.getId })
        transport.pushServer(["type": "worker-res", "id": getId, "ok": true, "value": ["token": "tok-stale"]])
        _ = try await pending.value
        #expect(delegate.tokens.isEmpty)

        // deleteData preserves _mintedSenderIDs when deleteDefaultRegistrationOnBroker fails.
        messaging.stateLock.withLock { _ = messaging._mintedSenderIDs.insert("sender-1") }
        box.lock.withLock { box.failDelete = true }
        do {
            try await messaging.deleteData()
            Issue.record("Expected deleteData failure")
        } catch {}
        let remaining = messaging.stateLock.withLock { messaging._mintedSenderIDs }
        #expect(remaining.contains("sender-1"))
    }
}
