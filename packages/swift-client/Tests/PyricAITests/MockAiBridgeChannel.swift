import Foundation
import PyricAI
import PyricFirestore

/// Thread-safe mock WebSocket transport for deterministic `PyricAI` unit tests.
final class MockAiBridgeChannel: WebSocketTransport, @unchecked Sendable {
    enum ReplyStep: Sendable {
        case unarySuccess(JSONObject)
        case unaryError(code: String, message: String, aiEnvelope: JSONObject?)
        case streamChunks(chunks: [JSONObject], finishAfterChunks: Bool)
        case streamError(code: String, message: String, aiEnvelope: JSONObject?, partialChunks: [JSONObject])
    }

    private let lock = NSLock()
    private var inboundQueue: [String] = []
    private var waiters: [CheckedContinuation<String, any Error>] = []
    private var replyQueue: [ReplyStep] = []
    private var sentOps: [[String: AnySendable]] = []
    private var sentSubs: [(subId: String, sub: [String: AnySendable])] = []
    private var sentUnsubs: [String] = []
    private var unsubContinuations: [CheckedContinuation<String, Never>] = []
    private var closed = false

    func enqueueReply(_ step: ReplyStep) {
        lock.lock()
        replyQueue.append(step)
        lock.unlock()
    }

    func recordedOps() -> [[String: AnySendable]] {
        lock.lock()
        defer { lock.unlock() }
        return sentOps
    }

    func recordedSubs() -> [(subId: String, sub: [String: AnySendable])] {
        lock.lock()
        defer { lock.unlock() }
        return sentSubs
    }

    func recordedUnsubs() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return sentUnsubs
    }

    func waitForNextUnsub() async -> String {
        await withCheckedContinuation { continuation in
            lock.lock()
            if !sentUnsubs.isEmpty {
                let first = sentUnsubs.removeFirst()
                lock.unlock()
                continuation.resume(returning: first)
                return
            }
            unsubContinuations.append(continuation)
            lock.unlock()
        }
    }

    func send(_ string: String) async throws {
        guard let data = string.data(using: .utf8),
              let frame = try? JSONDecoder().decode(AnySendable.self, from: data),
              let type = frame["type"]?.stringValue else {
            return
        }

        switch type {
        case "attach":
            pushInbound("{\"type\":\"attach-ack\",\"protocol\":1,\"peerConnected\":true,\"clientSessionId\":\"mock-ai-session\"}")

        case "ping":
            if let id = frame["id"]?.stringValue {
                pushInbound("{\"type\":\"pong\",\"id\":\"\(id)\"}")
            }

        case "worker-op":
            let id = frame["id"]?.stringValue ?? "ai-op-1"
            let opDict = frame["op"]?.dictionaryValue ?? [:]
            let step = recordOpAndPopStep(opDict)
            switch step {
            case .unarySuccess(let obj):
                let resFrame: [String: AnySendable] = [
                    "type": .string("worker-res"),
                    "id": .string(id),
                    "ok": .bool(true),
                    "value": JSONValue.object(obj).toAnySendable(),
                ]
                pushEncoded(resFrame)
            case .unaryError(let code, let message, let aiEnvelope):
                var errDict: [String: AnySendable] = [
                    "code": .string(code),
                    "message": .string(message),
                ]
                if let aiEnvelope {
                    errDict["aiEnvelope"] = JSONValue.object(aiEnvelope).toAnySendable()
                }
                let resFrame: [String: AnySendable] = [
                    "type": .string("worker-res"),
                    "id": .string(id),
                    "ok": .bool(false),
                    "error": .dictionary(errDict),
                ]
                pushEncoded(resFrame)
            case .none, .streamChunks, .streamError:
                let fallback: [String: AnySendable] = [
                    "type": .string("worker-res"),
                    "id": .string(id),
                    "ok": .bool(true),
                    "value": .dictionary([
                        "candidates": .array([
                            .dictionary([
                                "content": .dictionary([
                                    "role": .string("model"),
                                    "parts": .array([.dictionary(["text": .string("default-mock")])]),
                                ]),
                                "finishReason": .string("STOP"),
                            ]),
                        ]),
                    ]),
                ]
                pushEncoded(fallback)
            }

        case "worker-sub":
            let subId = frame["subId"]?.stringValue ?? "ai-sub-1"
            let subDict = frame["sub"]?.dictionaryValue ?? [:]
            let step = recordSubAndPopStep(subId: subId, sub: subDict)
            switch step {
            case .streamChunks(let chunks, let finishAfterChunks):
                for chunk in chunks {
                    let snap: [String: AnySendable] = [
                        "type": .string("worker-snap"),
                        "subId": .string(subId),
                        "value": .dictionary(["chunk": JSONValue.object(chunk).toAnySendable()]),
                    ]
                    pushEncoded(snap)
                }
                if finishAfterChunks {
                    let doneSnap: [String: AnySendable] = [
                        "type": .string("worker-snap"),
                        "subId": .string(subId),
                        "value": .dictionary(["done": .bool(true)]),
                    ]
                    pushEncoded(doneSnap)
                }
            case .streamError(let code, let message, let aiEnvelope, let partialChunks):
                for chunk in partialChunks {
                    let snap: [String: AnySendable] = [
                        "type": .string("worker-snap"),
                        "subId": .string(subId),
                        "value": .dictionary(["chunk": JSONValue.object(chunk).toAnySendable()]),
                    ]
                    pushEncoded(snap)
                }
                var errDict: [String: AnySendable] = [
                    "code": .string(code),
                    "message": .string(message),
                ]
                if let aiEnvelope {
                    errDict["aiEnvelope"] = JSONValue.object(aiEnvelope).toAnySendable()
                }
                let errSnap: [String: AnySendable] = [
                    "type": .string("worker-snap"),
                    "subId": .string(subId),
                    "value": .dictionary(["__error": .dictionary(errDict)]),
                ]
                pushEncoded(errSnap)
            default:
                break
            }

        case "worker-unsub":
            if let subId = frame["subId"]?.stringValue {
                recordUnsub(subId)
            }

        default:
            break
        }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if closed {
                lock.unlock()
                continuation.resume(throwing: CancellationError())
                return
            }
            if !inboundQueue.isEmpty {
                let next = inboundQueue.removeFirst()
                lock.unlock()
                continuation.resume(returning: next)
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    func close(closeCode: Int, reason: String?) async {
        _ = closeCode
        _ = reason
        let pending: [CheckedContinuation<String, any Error>] = {
            lock.lock()
            defer { lock.unlock() }
            closed = true
            let current = waiters
            waiters.removeAll()
            return current
        }()
        for waiter in pending {
            waiter.resume(throwing: CancellationError())
        }
    }

    private func recordOpAndPopStep(_ op: [String: AnySendable]) -> ReplyStep? {
        lock.lock()
        defer { lock.unlock() }
        sentOps.append(op)
        return replyQueue.isEmpty ? nil : replyQueue.removeFirst()
    }

    private func recordSubAndPopStep(subId: String, sub: [String: AnySendable]) -> ReplyStep? {
        lock.lock()
        defer { lock.unlock() }
        sentSubs.append((subId: subId, sub: sub))
        return replyQueue.isEmpty ? nil : replyQueue.removeFirst()
    }

    private func recordUnsub(_ subId: String) {
        let waiter: CheckedContinuation<String, Never>? = {
            lock.lock()
            defer { lock.unlock() }
            if !unsubContinuations.isEmpty {
                return unsubContinuations.removeFirst()
            }
            sentUnsubs.append(subId)
            return nil
        }()
        waiter?.resume(returning: subId)
    }

    private func pushEncoded(_ dict: [String: AnySendable]) {
        if let data = try? JSONEncoder().encode(dict),
           let str = String(data: data, encoding: .utf8) {
            pushInbound(str)
        }
    }

    private func pushInbound(_ raw: String) {
        let waiter: CheckedContinuation<String, any Error>? = {
            lock.lock()
            defer { lock.unlock() }
            if !waiters.isEmpty {
                return waiters.removeFirst()
            }
            inboundQueue.append(raw)
            return nil
        }()
        waiter?.resume(returning: raw)
    }
}
