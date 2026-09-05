import Foundation
import PyricFirestore

public final class MockAuthChannel: WebSocketTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var incomingQueue: [String] = []
    private var receiveContinuations: [CheckedContinuation<String, Error>] = []
    private var sentQueue: [[String: AnySendable]] = []
    private var sentContinuations: [CheckedContinuation<[String: AnySendable], Error>] = []
    public private(set) var isClosed = false

    public init() {}

    private func withLock<T>(_ block: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try block()
    }

    public func send(_ text: String) async throws {
        let (continuationToResume, dict) = try withLock { () throws -> (CheckedContinuation<[String: AnySendable], Error>?, [String: AnySendable]?) in
            guard !isClosed else {
                throw PyricBridgeError.unavailable("Cannot send message: WebSocket is closed.")
            }
            if let data = text.data(using: .utf8),
               let obj = try? JSONDecoder().decode(AnySendable.self, from: data),
               let dict = obj.dictionaryValue {
                if !sentContinuations.isEmpty {
                    let cont = sentContinuations.removeFirst()
                    return (cont, dict)
                } else {
                    sentQueue.append(dict)
                }
            }
            return (nil, nil)
        }
        if let continuationToResume, let dict {
            continuationToResume.resume(returning: dict)
        }
    }

    public func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let msgToReturn: String? = withLock {
                if isClosed {
                    continuation.resume(throwing: PyricBridgeError.unavailable("WebSocket stream closed."))
                    return nil
                }
                if !incomingQueue.isEmpty {
                    return incomingQueue.removeFirst()
                } else {
                    receiveContinuations.append(continuation)
                    return nil
                }
            }
            if let msgToReturn {
                continuation.resume(returning: msgToReturn)
            }
        }
    }

    public func close(closeCode: Int = 1000, reason: String? = nil) async {
        let (recv, sent) = withLock { () -> ([CheckedContinuation<String, Error>], [CheckedContinuation<[String: AnySendable], Error>]) in
            isClosed = true
            let r = receiveContinuations
            receiveContinuations.removeAll()
            let s = sentContinuations
            sentContinuations.removeAll()
            return (r, s)
        }
        for cont in recv {
            cont.resume(throwing: PyricBridgeError.unavailable("WebSocket closed."))
        }
        for cont in sent {
            cont.resume(throwing: PyricBridgeError.unavailable("WebSocket closed."))
        }
    }

    public func simulateServerMessage(_ dict: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: dict)
        let str = String(decoding: data, as: UTF8.self)
        let contToResume: CheckedContinuation<String, Error>? = withLock {
            if !receiveContinuations.isEmpty {
                return receiveContinuations.removeFirst()
            } else {
                incomingQueue.append(str)
                return nil
            }
        }
        contToResume?.resume(returning: str)
    }

    public func awaitNextSentMessage(timeoutSeconds: Double = 3.0) async throws -> [String: AnySendable] {
        try await withThrowingTaskGroup(of: [String: AnySendable].self) { group in
            group.addTask {
                try await withCheckedThrowingContinuation { continuation in
                    let msgToReturn: [String: AnySendable]? = self.withLock {
                        if !self.sentQueue.isEmpty {
                            return self.sentQueue.removeFirst()
                        } else {
                            self.sentContinuations.append(continuation)
                            return nil
                        }
                    }
                    if let msgToReturn {
                        continuation.resume(returning: msgToReturn)
                    }
                }
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                throw PyricBridgeError.deadlineExceeded("Timed out waiting for client frame")
            }
            let res = try await group.next()!
            group.cancelAll()
            return res
        }
    }
}
