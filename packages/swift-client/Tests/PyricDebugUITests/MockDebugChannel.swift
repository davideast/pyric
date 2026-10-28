import Foundation
import Testing
import PyricFirestore
import FirebaseAuth
import PyricDebugUI

public final class MockDebugChannel: WebSocketTransport, @unchecked Sendable {
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
                // Heartbeat pings are not frames these tests drive.
                if dict["type"]?.stringValue == "ping" { return (nil, nil) }
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

/// Waits for `condition` to hold, checking every 5 ms. Records an issue at the
/// caller and throws after 6 s, so a wrong result still fails the test.
func until(
    _ condition: @Sendable () async -> Bool,
    sourceLocation: SourceLocation = #_sourceLocation
) async throws {
    for _ in 0..<1200 {
        if await condition() { return }
        try await Task.sleep(nanoseconds: 5_000_000)
    }
    Issue.record("condition not reached", sourceLocation: sourceLocation)
    throw PyricBridgeError.deadlineExceeded("condition not reached")
}

/// `Auth` subscribes to the bridge's remote-lens stream from a task, and the
/// bridge drops a remote-lens frame that arrives before that subscription
/// registers. Pushes an app-session lens until `auth` applies one, then pushes
/// anonymous and waits for `manager` to show it. Frames sent after this
/// returns reach `auth`, and `manager` starts from anonymous.
func awaitRemoteLensSubscription(
    _ channel: MockDebugChannel,
    _ auth: Auth,
    _ manager: PyricDebugManager
) async throws {
    let probe: [String: Any] = ["type": "worker-event", "event": "remote-lens", "lens": ["mode": "app-session"]]
    try channel.simulateServerMessage(probe)
    for attempt in 1...1200 {
        if auth.currentAuthLens() == .appSession { break }
        if attempt % 20 == 0 { try channel.simulateServerMessage(probe) }
        try await Task.sleep(nanoseconds: 5_000_000)
    }
    try await until { await manager.activeLens == .appSession }
    try channel.simulateServerMessage(["type": "worker-event", "event": "remote-lens", "lens": ["mode": "anon"]])
    try await until { await manager.activeLens == .anon }
}
