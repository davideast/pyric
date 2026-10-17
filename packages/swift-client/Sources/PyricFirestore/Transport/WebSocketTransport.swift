import Foundation

/// Abstract transport layer enabling offline unit tests without real sockets.
public protocol WebSocketTransport: Sendable {
    /// Writes one text frame. A throw means the frame may have reached the
    /// host, so the client fails the operation it carried and never re-sends it.
    func send(_ string: String) async throws
    func receive() async throws -> String
    func close(closeCode: Int, reason: String?) async
}

public typealias WebSocketChannelProtocol = WebSocketTransport

/// Thrown by `URLSessionWebSocketTransport.send` when it refuses a frame
/// without writing it, because its task is no longer running. The frame never
/// left the device, so the client holds its operation for the reconnect
/// (ADR-0019, amended 2026-10-17). Package access only: a custom transport
/// cannot signal a refusal, so anything it throws leaves the operation in flight.
package struct WebSocketSendRefusedError: Error, Sendable {
    package init() {}
}

/// Native implementation backed by URLSessionWebSocketTask.
public final class URLSessionWebSocketTransport: WebSocketTransport, @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let session: URLSession

    public init(request: URLRequest, configuration: URLSessionConfiguration = .default) {
        self.session = URLSession(configuration: configuration)
        self.task = session.webSocketTask(with: request)
        self.task.resume()
    }

    public func send(_ string: String) async throws {
        // A task that has stopped running cannot write. Apple does not document
        // whether a send that throws wrote nothing, so only this check is a refusal.
        let running = task.state == .running
        guard running else { throw WebSocketSendRefusedError() }
        try await task.send(.string(string))
    }

    public func receive() async throws -> String {
        let msg: URLSessionWebSocketTask.Message
        do {
            msg = try await task.receive()
        } catch {
            let closeCode = task.closeCode
            if closeCode != .invalid {
                let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) }
                throw WebSocketCloseError(closeCode: closeCode.rawValue, reason: reason)
            }
            throw error
        }
        switch msg {
        case .string(let text):
            return text
        case .data(let data):
            guard let text = String(data: data, encoding: .utf8) else {
                throw PyricBridgeError.unavailable("Received non-UTF8 binary frame from bridge")
            }
            return text
        @unknown default:
            throw PyricBridgeError.unavailable("Unknown WebSocket message type")
        }
    }

    public func close(closeCode: Int = 1000, reason: String? = nil) async {
        let closeReason = reason?.data(using: .utf8)
        let code = URLSessionWebSocketTask.CloseCode(rawValue: closeCode) ?? .normalClosure
        task.cancel(with: code, reason: closeReason)
        session.invalidateAndCancel()
    }
}
