import Foundation

/// Abstract transport layer enabling offline unit tests without real sockets.
public protocol WebSocketTransport: Sendable {
    func send(_ string: String) async throws
    func receive() async throws -> String
    func close(closeCode: Int, reason: String?) async
}

public typealias WebSocketChannelProtocol = WebSocketTransport

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
        try await task.send(.string(string))
    }

    public func receive() async throws -> String {
        let msg = try await task.receive()
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
