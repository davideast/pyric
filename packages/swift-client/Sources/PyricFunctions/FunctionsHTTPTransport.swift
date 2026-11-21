import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

package struct FunctionsHTTPResponse: Sendable {
    package let statusCode: Int
    package let headers: [String: String]
    package let body: Data

    package init(statusCode: Int, headers: [String: String] = [:], body: Data) {
        self.statusCode = statusCode
        self.headers = headers
        self.body = body
    }
}

package protocol FunctionsHTTPTransport: Sendable {
    func postJSON(
        url: URL,
        headers: [String: String],
        body: Data,
        timeout: TimeInterval
    ) async throws -> FunctionsHTTPResponse

    func postSSE(
        url: URL,
        headers: [String: String],
        body: Data,
        timeout: TimeInterval,
        region: String,
        reportedURL: URL,
        serializer: FunctionsSerializer
    ) -> AsyncThrowingStream<String, Error>
}

/// Incremental byte-level UTF-8 SSE line accumulator extracting `data:` payloads across arbitrary TCP chunks.
package struct SSELineAccumulator: Sendable {
    private var buffer = Data()

    package init() {}

    package mutating func append(_ chunk: Data) -> [String] {
        guard !chunk.isEmpty else {
            return []
        }
        buffer.append(chunk)
        var payloads: [String] = []
        while let newlineIndex = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: buffer.startIndex..<newlineIndex)
            buffer.removeSubrange(buffer.startIndex...newlineIndex)
            if let extracted = Self.extractDataPayload(from: lineData) {
                payloads.append(extracted)
            }
        }
        return payloads
    }

    package mutating func flush() -> [String] {
        guard !buffer.isEmpty else {
            return []
        }
        let remaining = buffer
        buffer.removeAll(keepingCapacity: false)
        if let extracted = Self.extractDataPayload(from: remaining) {
            return [extracted]
        }
        return []
    }

    private static func extractDataPayload(from lineData: Data) -> String? {
        guard let rawLine = String(data: lineData, encoding: .utf8) else {
            return nil
        }
        let trimmed = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("data:") else {
            return nil
        }
        let payload = trimmed.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
        return payload.isEmpty ? nil : payload
    }
}

package final class URLSessionFunctionsHTTPTransport: FunctionsHTTPTransport, Sendable {
    package init() {}

    package func postJSON(
        url: URL,
        headers: [String: String],
        body: Data,
        timeout: TimeInterval
    ) async throws -> FunctionsHTTPResponse {
        let effectiveTimeout = timeout > 0 ? timeout : HTTPSCallable.defaultTimeoutInterval
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = effectiveTimeout
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        request.httpBody = body

        let raceState = UnaryRaceState()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let config = URLSessionConfiguration.ephemeral
                config.timeoutIntervalForRequest = effectiveTimeout
                config.timeoutIntervalForResource = effectiveTimeout
                let session = URLSession(configuration: config)

                let dataTask = session.dataTask(with: request) { data, response, error in
                    session.finishTasksAndInvalidate()
                    if let error {
                        raceState.finish(with: .failure(Self.mapTransportError(error, timedOutByTimer: raceState.didTimeOut)))
                        return
                    }
                    guard let httpResponse = response as? HTTPURLResponse else {
                        raceState.finish(
                            with: .failure(
                                FunctionsError(.internal, message: "Response was not an HTTP response.", url: url)
                            )
                        )
                        return
                    }
                    var loweredHeaders: [String: String] = [:]
                    for (rawKey, rawVal) in httpResponse.allHeaderFields {
                        loweredHeaders[String(describing: rawKey).lowercased()] = String(describing: rawVal)
                    }
                    raceState.finish(
                        with: .success(
                            FunctionsHTTPResponse(
                                statusCode: httpResponse.statusCode,
                                headers: loweredHeaders,
                                body: data ?? Data()
                            )
                        )
                    )
                }

                let timeoutNanos = Self.secondsToNanoseconds(effectiveTimeout)
                let timerTask = Task {
                    try? await Task.sleep(nanoseconds: timeoutNanos)
                    guard !Task.isCancelled else {
                        return
                    }
                    raceState.markTimedOutAndCancel(url: url)
                }

                raceState.install(
                    continuation: continuation,
                    task: dataTask,
                    session: session,
                    timerTask: timerTask
                )
            }
        } onCancel: {
            raceState.cancelFromCaller()
        }
    }

    package func postSSE(
        url: URL,
        headers: [String: String],
        body: Data,
        timeout: TimeInterval,
        region: String,
        reportedURL: URL,
        serializer: FunctionsSerializer
    ) -> AsyncThrowingStream<String, Error> {
        #if canImport(FoundationNetworking)
        return postSSELinuxDelegate(
            url: url,
            headers: headers,
            body: body,
            timeout: timeout,
            region: region,
            reportedURL: reportedURL,
            serializer: serializer
        )
        #else
        return postSSEDarwinAsyncBytes(
            url: url,
            headers: headers,
            body: body,
            timeout: timeout,
            region: region,
            reportedURL: reportedURL,
            serializer: serializer
        )
        #endif
    }

    #if canImport(FoundationNetworking)
    private func postSSELinuxDelegate(
        url: URL,
        headers: [String: String],
        body: Data,
        timeout: TimeInterval,
        region: String,
        reportedURL: URL,
        serializer: FunctionsSerializer
    ) -> AsyncThrowingStream<String, Error> {
        let effectiveTimeout = timeout > 0 ? timeout : HTTPSCallable.defaultTimeoutInterval
        return AsyncThrowingStream { continuation in
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = max(effectiveTimeout, 300.0)
            for (key, value) in headers {
                request.setValue(value, forHTTPHeaderField: key)
            }
            request.httpBody = body

            let delegate = LinuxSSEDataDelegate(
                continuation: continuation,
                region: region,
                reportedURL: reportedURL,
                serializer: serializer
            )
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = max(effectiveTimeout, 300.0)
            config.timeoutIntervalForResource = 0
            let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
            let dataTask = session.dataTask(with: request)
            delegate.attach(session: session, task: dataTask)
            dataTask.resume()

            continuation.onTermination = { @Sendable termination in
                if case .cancelled = termination {
                    delegate.cancelFromConsumer()
                }
            }
        }
    }
    #else
    private func postSSEDarwinAsyncBytes(
        url: URL,
        headers: [String: String],
        body: Data,
        timeout: TimeInterval,
        region: String,
        reportedURL: URL,
        serializer: FunctionsSerializer
    ) -> AsyncThrowingStream<String, Error> {
        let effectiveTimeout = timeout > 0 ? timeout : HTTPSCallable.defaultTimeoutInterval
        return AsyncThrowingStream { continuation in
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = max(effectiveTimeout, 300.0)
            config.timeoutIntervalForResource = 0
            let session = URLSession(configuration: config)

            let workerTask = Task {
                defer {
                    session.finishTasksAndInvalidate()
                }
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.timeoutInterval = max(effectiveTimeout, 300.0)
                for (key, value) in headers {
                    request.setValue(value, forHTTPHeaderField: key)
                }
                request.httpBody = body

                do {
                    let (asyncBytes, rawResponse) = try await session.bytes(for: request)
                    guard let httpResponse = rawResponse as? HTTPURLResponse else {
                        continuation.finish(
                            throwing: FunctionsError(
                                .unavailable,
                                message: "Response was not an HTTP response.",
                                region: region,
                                url: reportedURL
                            )
                        )
                        return
                    }

                    if !(200...299).contains(httpResponse.statusCode) {
                        var errorBody = Data()
                        for try await byte in asyncBytes {
                            errorBody.append(byte)
                        }
                        let mapped = FunctionsError.fromResponse(
                            httpStatusCode: httpResponse.statusCode,
                            region: region,
                            url: reportedURL,
                            body: errorBody,
                            serializer: serializer
                        ) ?? FunctionsError(
                            FunctionsErrorCode(httpStatusCode: httpResponse.statusCode),
                            region: region,
                            url: reportedURL
                        )
                        continuation.finish(throwing: mapped)
                        return
                    }

                    var accumulator = SSELineAccumulator()
                    var chunk = Data()
                    chunk.reserveCapacity(256)
                    for try await byte in asyncBytes {
                        try Task.checkCancellation()
                        chunk.append(byte)
                        if byte == 0x0A {
                            for line in accumulator.append(chunk) {
                                continuation.yield(line)
                            }
                            chunk.removeAll(keepingCapacity: true)
                        }
                    }
                    if !chunk.isEmpty {
                        for line in accumulator.append(chunk) {
                            continuation.yield(line)
                        }
                    }
                    for trailing in accumulator.flush() {
                        continuation.yield(trailing)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(throwing: FunctionsError(.cancelled, region: region, url: reportedURL))
                } catch {
                    continuation.finish(
                        throwing: Self.mapTransportError(error, timedOutByTimer: false, region: region, url: reportedURL)
                    )
                }
            }

            continuation.onTermination = { @Sendable termination in
                if case .cancelled = termination {
                    workerTask.cancel()
                    session.invalidateAndCancel()
                }
            }
        }
    }
    #endif

    package static func mapTransportError(
        _ error: any Error,
        timedOutByTimer: Bool,
        region: String? = nil,
        url: URL? = nil
    ) -> FunctionsError {
        if let existing = error as? FunctionsError {
            return existing
        }
        if timedOutByTimer {
            return FunctionsError(.deadlineExceeded, region: region, url: url, underlyingError: error)
        }
        if error is CancellationError {
            return FunctionsError(.cancelled, region: region, url: url, underlyingError: error)
        }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            if nsError.code == NSURLErrorTimedOut {
                return FunctionsError(.deadlineExceeded, region: region, url: url, underlyingError: error)
            }
            if nsError.code == NSURLErrorCancelled {
                return FunctionsError(.cancelled, region: region, url: url, underlyingError: error)
            }
        }
        return FunctionsError(
            .internal,
            message: FunctionsErrorCode.internal.defaultDescription,
            region: region,
            url: url,
            underlyingError: error
        )
    }

    private static func secondsToNanoseconds(_ seconds: TimeInterval) -> UInt64 {
        let clamped = min(max(seconds, 0.001), 3_600.0)
        return UInt64((clamped * 1_000_000_000.0).rounded())
    }
}
