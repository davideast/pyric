import Foundation
import PyricFirestore

final class MockAppCheckBridgeChannel: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var incomingQueue: [String] = []
    private var receiveContinuations: [CheckedContinuation<String, Error>] = []
    private var sentOps: [[String: AnySendable]] = []
    private var serverHandler: (@Sendable ([String: AnySendable], MockAppCheckBridgeChannel) -> Void)?
    private(set) var isClosed = false

    init(onClientMessage: (@Sendable ([String: AnySendable], MockAppCheckBridgeChannel) -> Void)? = nil) {
        self.serverHandler = onClientMessage
    }

    var recordedOps: [[String: AnySendable]] {
        lock.lock()
        defer { lock.unlock() }
        return sentOps
    }

    func send(_ text: String) async throws {
        let parsed: ([String: AnySendable], (@Sendable ([String: AnySendable], MockAppCheckBridgeChannel) -> Void)?)? = try {
            lock.lock()
            defer { lock.unlock() }
            if isClosed {
                throw PyricBridgeError.unavailable("Mock WebSocket channel is closed.")
            }
            guard let data = text.data(using: .utf8),
                  let decoded = try? JSONDecoder().decode(AnySendable.self, from: data),
                  let dict = decoded.dictionaryValue else {
                return nil
            }
            if dict["type"]?.stringValue == "ping" {
                return nil
            }
            if dict["type"]?.stringValue == "worker-op",
               let opPayload = dict["op"]?.dictionaryValue {
                sentOps.append(opPayload)
            }
            return (dict, serverHandler)
        }()

        if let (frame, handler) = parsed {
            handler?(frame, self)
        }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let buffered: String? = {
                lock.lock()
                defer { lock.unlock() }
                if isClosed {
                    continuation.resume(throwing: PyricBridgeError.unavailable("Mock WebSocket closed."))
                    return nil
                }
                if !incomingQueue.isEmpty {
                    return incomingQueue.removeFirst()
                }
                receiveContinuations.append(continuation)
                return nil
            }()
            if let buffered {
                continuation.resume(returning: buffered)
            }
        }
    }

    func close(closeCode: Int = 1000, reason: String? = nil) async {
        let waiters: [CheckedContinuation<String, Error>] = {
            lock.lock()
            defer { lock.unlock() }
            isClosed = true
            let current = receiveContinuations
            receiveContinuations.removeAll()
            return current
        }()
        for waiter in waiters {
            waiter.resume(throwing: PyricBridgeError.unavailable("Mock WebSocket closed."))
        }
    }

    func sendFromServer(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else {
            return
        }
        let waiter: CheckedContinuation<String, Error>? = {
            lock.lock()
            defer { lock.unlock() }
            if !receiveContinuations.isEmpty {
                return receiveContinuations.removeFirst()
            }
            incomingQueue.append(json)
            return nil
        }()
        waiter?.resume(returning: json)
    }
}
