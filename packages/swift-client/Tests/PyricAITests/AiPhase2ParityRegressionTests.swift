import Foundation
import Testing
@testable import PyricAI
import PyricFirestore

private final class DelayedAttachChannel: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var inbound: [String] = []
    private var waiters: [CheckedContinuation<String, any Error>] = []
    private var attachCount = 0
    private var closed = false
    private let onFrame: @Sendable ([String: AnySendable], DelayedAttachChannel) -> Void

    init(onFrame: @escaping @Sendable ([String: AnySendable], DelayedAttachChannel) -> Void) {
        self.onFrame = onFrame
    }

    var attachesSent: Int {
        lock.lock()
        defer { lock.unlock() }
        return attachCount
    }

    private func recordAttach() {
        lock.lock()
        attachCount += 1
        lock.unlock()
    }

    func send(_ text: String) async throws {
        guard let data = text.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(AnySendable.self, from: data),
              let dict = decoded.dictionaryValue else { return }
        if dict["type"]?.stringValue == "attach" {
            recordAttach()
        }
        onFrame(dict, self)
    }

    func enqueue(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8) else { return }
        let waiter: CheckedContinuation<String, any Error>? = {
            lock.lock()
            defer { lock.unlock() }
            if !waiters.isEmpty { return waiters.removeFirst() }
            inbound.append(text)
            return nil
        }()
        waiter?.resume(returning: text)
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            lock.lock()
            if closed {
                lock.unlock()
                cont.resume(throwing: CancellationError())
                return
            }
            if !inbound.isEmpty {
                let next = inbound.removeFirst()
                lock.unlock()
                cont.resume(returning: next)
                return
            }
            waiters.append(cont)
            lock.unlock()
        }
    }

    func close(closeCode: Int, reason: String?) async {
        let pending: [CheckedContinuation<String, any Error>] = {
            lock.lock()
            defer { lock.unlock() }
            closed = true
            let all = waiters
            waiters.removeAll()
            return all
        }()
        for w in pending { w.resume(throwing: CancellationError()) }
    }
}

@Suite("PyricAI Phase 2 Parity Regression Suite", .serialized)
struct AiPhase2ParityRegressionTests {
    @Test("P2-S07: concurrent unaryOp calls coalesce ensureAttached without continuation misuse or deadlock")
    func concurrentEnsureAttachedCoalesces() async throws {
        let channel = DelayedAttachChannel { frame, ch in
            let type = frame["type"]?.stringValue
            if type == "attach" {
                Task {
                    try? await Task.sleep(nanoseconds: 30_000_000)
                    ch.enqueue([
                        "type": "attach-ack",
                        "protocol": 1,
                        "peerConnected": true,
                        "clientSessionId": "ai-coalesce",
                    ])
                }
            } else if type == "worker-op", let id = frame["id"]?.stringValue {
                ch.enqueue([
                    "type": "worker-res",
                    "id": id,
                    "ok": true,
                    "value": ["totalTokens": 7],
                ])
            }
        }
        let session = AiBridgeSession(fixedTransport: channel)
        let endpoint = URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!
        let claim = AiAppCheckResolver.ResolvedClaim(claimObject: nil, attachedToken: nil)

        try await withThrowingTaskGroup(of: Int.self) { group in
            for _ in 0..<4 {
                group.addTask {
                    let res = try await session.unaryOp(
                        endpoint: endpoint,
                        headers: [:],
                        method: "ai.countTokens",
                        model: "models/gemini-2.5-flash",
                        request: .dictionary([:]),
                        engine: nil,
                        appCheck: claim,
                        timeout: 5.0
                    )
                    return Int(res["totalTokens"]?.intValue ?? 0)
                }
            }
            var total = 0
            for try await v in group { total += v }
            #expect(total == 28)
        }
        #expect(channel.attachesSent == 1)
        await session.disconnect()
    }

    @Test("P2-S08: unaryOp cancels promptly on Task.cancel and clamps infinite timeout without overflow")
    func unaryOpCancellationAndInfiniteTimeout() async throws {
        let channel = DelayedAttachChannel { frame, ch in
            if frame["type"]?.stringValue == "attach" {
                ch.enqueue([
                    "type": "attach-ack",
                    "protocol": 1,
                    "peerConnected": true,
                    "clientSessionId": "ai-cancel",
                ])
            }
        }
        let session = AiBridgeSession(fixedTransport: channel)
        let endpoint = URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!
        let claim = AiAppCheckResolver.ResolvedClaim(claimObject: nil, attachedToken: nil)

        let task = Task {
            try await session.unaryOp(
                endpoint: endpoint,
                headers: [:],
                method: "ai.generateContent",
                model: "models/gemini-2.5-flash",
                request: .dictionary([:]),
                engine: nil,
                appCheck: claim,
                timeout: .infinity
            )
        }
        try await Task.sleep(nanoseconds: 25_000_000)
        task.cancel()
        var cancelled = false
        do {
            _ = try await task.value
        } catch is CancellationError {
            cancelled = true
        }
        #expect(cancelled == true)
        await session.disconnect()
    }

    @Test("P2-F11 / P2-K15: Schema preserves exact 64-bit Int bounds and rejects non-finite Double bounds on encode")
    func schemaExactIntAndNonFiniteReject() throws {
        let exact = 9_007_199_254_740_993
        let intSchema = Schema.integer(minimum: exact, maximum: exact + 2)
        let data = try JSONEncoder().encode(intSchema)
        let text = try #require(String(data: data, encoding: .utf8))
        #expect(text.contains("9007199254740993"))
        #expect(text.contains("9007199254740995"))

        let badSchema = Schema.double(minimum: .nan)
        var threw = false
        do {
            _ = try JSONEncoder().encode(badSchema)
        } catch {
            threw = true
        }
        #expect(threw == true)
    }
}
