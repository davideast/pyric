import Foundation
@testable import PyricFunctions

struct RecordedFunctionsHTTPRequest: @unchecked Sendable {
    let url: URL
    let headers: [String: String]
    let bodyJSON: [String: Any]?
    let timeout: TimeInterval
    let isSSE: Bool
}

final class MockFunctionsHTTPTransport: FunctionsHTTPTransport, @unchecked Sendable {
    enum SSEDirective: Sendable {
        case rawChunk(Data)
        case delayMilliseconds(UInt64)
        case transportFailure(FunctionsErrorCode, String)
    }

    struct ScriptedSSE: Sendable {
        let non2xxResponse: FunctionsHTTPResponse?
        let directives: [SSEDirective]

        init(non2xxResponse: FunctionsHTTPResponse? = nil, directives: [SSEDirective] = []) {
            self.non2xxResponse = non2xxResponse
            self.directives = directives
        }
    }

    private let lock = NSLock()
    private var recorded: [RecordedFunctionsHTTPRequest] = []
    private var unaryHandler: (@Sendable (RecordedFunctionsHTTPRequest) async throws -> FunctionsHTTPResponse)?
    private var sseHandler: (@Sendable (RecordedFunctionsHTTPRequest) -> ScriptedSSE)?
    private var sseCancelledCount = 0

    var requests: [RecordedFunctionsHTTPRequest] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    var cancelledSSEStreams: Int {
        lock.lock()
        defer { lock.unlock() }
        return sseCancelledCount
    }

    func onUnary(
        _ handler: @escaping @Sendable (RecordedFunctionsHTTPRequest) async throws -> FunctionsHTTPResponse
    ) {
        lock.lock()
        unaryHandler = handler
        lock.unlock()
    }

    func onSSE(
        _ handler: @escaping @Sendable (RecordedFunctionsHTTPRequest) -> ScriptedSSE
    ) {
        lock.lock()
        sseHandler = handler
        lock.unlock()
    }

    func postJSON(
        url: URL,
        headers: [String: String],
        body: Data,
        timeout: TimeInterval
    ) async throws -> FunctionsHTTPResponse {
        let parsed = (try? JSONSerialization.jsonObject(with: body, options: [])) as? [String: Any]
        let req = RecordedFunctionsHTTPRequest(
            url: url,
            headers: headers,
            bodyJSON: parsed,
            timeout: timeout,
            isSSE: false
        )
        let handler: (@Sendable (RecordedFunctionsHTTPRequest) async throws -> FunctionsHTTPResponse)? = {
            lock.lock()
            defer { lock.unlock() }
            recorded.append(req)
            return unaryHandler
        }()
        guard let handler else {
            return FunctionsHTTPResponse(
                statusCode: 200,
                body: Data(#"{"result":null}"#.utf8)
            )
        }
        return try await handler(req)
    }

    func postSSE(
        url: URL,
        headers: [String: String],
        body: Data,
        timeout: TimeInterval,
        region: String,
        reportedURL: URL,
        serializer: FunctionsSerializer
    ) -> AsyncThrowingStream<String, Error> {
        let parsed = (try? JSONSerialization.jsonObject(with: body, options: [])) as? [String: Any]
        let req = RecordedFunctionsHTTPRequest(
            url: url,
            headers: headers,
            bodyJSON: parsed,
            timeout: timeout,
            isSSE: true
        )
        let scripted: ScriptedSSE = {
            lock.lock()
            defer { lock.unlock() }
            recorded.append(req)
            return sseHandler?(req) ?? ScriptedSSE()
        }()

        return AsyncThrowingStream { continuation in
            let task = Task {
                if let errRes = scripted.non2xxResponse {
                    let mapped = FunctionsError.fromResponse(
                        httpStatusCode: errRes.statusCode,
                        region: region,
                        url: reportedURL,
                        body: errRes.body,
                        serializer: serializer
                    ) ?? FunctionsError(
                        FunctionsErrorCode(httpStatusCode: errRes.statusCode),
                        region: region,
                        url: reportedURL
                    )
                    continuation.finish(throwing: mapped)
                    return
                }

                var accumulator = SSELineAccumulator()
                do {
                    for step in scripted.directives {
                        try Task.checkCancellation()
                        switch step {
                        case .rawChunk(let chunk):
                            for line in accumulator.append(chunk) {
                                continuation.yield(line)
                            }
                        case .delayMilliseconds(let ms):
                            try await Task.sleep(nanoseconds: ms * 1_000_000)
                        case .transportFailure(let code, let message):
                            throw FunctionsError(code, message: message, region: region, url: reportedURL)
                        }
                    }
                    for trailing in accumulator.flush() {
                        continuation.yield(trailing)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(throwing: FunctionsError(.cancelled, region: region, url: reportedURL))
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { @Sendable termination in
                if case .cancelled = termination {
                    self.lock.lock()
                    self.sseCancelledCount += 1
                    self.lock.unlock()
                    task.cancel()
                }
            }
        }
    }
}
