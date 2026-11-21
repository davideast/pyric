import Foundation

/// Contains the decoded result returned by a Callable HTTPS trigger,
/// matching `FirebaseFunctions.HTTPSCallableResult` (`13.2.0`).
open class HTTPSCallableResult: NSObject, @unchecked Sendable {
    /// Decoded native Swift payload returned by the callable function (`[String: Any]`, `[Any]`, `String`, `Int`, `UInt`, `Double`, `Bool`, or `NSNull`).
    public let data: Any

    public init(data: Any) {
        self.data = data
        super.init()
    }
}

package protocol _FunctionsStreamResponseMarker {}

/// Represents a progressive message or terminal result yielded by a streaming callable function,
/// matching `FirebaseFunctions.StreamResponse` (`13.2.0`) and untyped `HTTPSCallable.stream`.
public enum StreamResponse<Message, Result>: @unchecked Sendable, _FunctionsStreamResponseMarker {
    case message(Message)
    case result(Result)
}

extension StreamResponse: Equatable where Message: Equatable, Result: Equatable {}

extension StreamResponse: Decodable where Message: Decodable, Result: Decodable {
    private enum CodingKeys: String, CodingKey {
        case message
        case result
    }

    public init(from decoder: any Decoder) throws {
        do {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let hasMessage = container.contains(.message)
            let hasResult = container.contains(.result)
            guard hasMessage != hasResult else {
                throw DecodingError.typeMismatch(
                    Self.self,
                    DecodingError.Context(
                        codingPath: container.codingPath,
                        debugDescription: "Invalid number of keys found in StreamResponse; expected exactly one of 'message' or 'result'."
                    )
                )
            }
            if hasMessage {
                self = .message(try container.decode(Message.self, forKey: .message))
            } else {
                self = .result(try container.decode(Result.self, forKey: .result))
            }
        } catch let fnError as FunctionsError {
            throw fnError
        } catch {
            throw FunctionsError(
                .dataLoss,
                message: FunctionsErrorCode.dataLoss.defaultDescription,
                underlyingError: error
            )
        }
    }
}

/// Untyped streaming event alias yielded by `HTTPSCallable.stream(_:)`.
public typealias HTTPSCallableStreamResponse = StreamResponse<Any, HTTPSCallableResult>

package struct UncheckedSendableBox: @unchecked Sendable {
    package let value: Any?

    package init(_ value: Any?) {
        self.value = value
    }
}

/// Reference to a Callable HTTPS trigger in Cloud Functions,
/// matching `FirebaseFunctions.HTTPSCallable` (`13.2.0`).
public final class HTTPSCallable: NSObject, @unchecked Sendable {
    package enum TargetSpec: Sendable {
        case named(String)
        case url(URL)
    }

    public static let defaultTimeoutInterval: TimeInterval = 70.0

    private let functions: Functions
    private let targetSpec: TargetSpec
    public let options: HTTPSCallableOptions?

    private let lock = NSLock()
    private var _timeoutInterval: TimeInterval = HTTPSCallable.defaultTimeoutInterval

    /// Request timeout in seconds when calling the function (defaults to `70.0`).
    public var timeoutInterval: TimeInterval {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _timeoutInterval
        }
        set {
            lock.lock()
            _timeoutInterval = newValue
            lock.unlock()
        }
    }

    package init(
        functions: Functions,
        targetSpec: TargetSpec,
        options: HTTPSCallableOptions? = nil
    ) {
        self.functions = functions
        self.targetSpec = targetSpec
        self.options = options
        super.init()
    }

    /// Executes this Callable HTTPS trigger asynchronously and returns the decoded `HTTPSCallableResult`.
    public func call(_ data: Any? = nil) async throws -> HTTPSCallableResult {
        let boxed = UncheckedSendableBox(data)
        return try await functions.executeCall(
            targetSpec: targetSpec,
            data: boxed,
            options: options,
            timeout: timeoutInterval
        )
    }

    /// Completion-handler overload executing this Callable HTTPS trigger with optional `data`.
    public func call(
        _ data: Any?,
        completion: @escaping @Sendable (HTTPSCallableResult?, Error?) -> Void
    ) {
        let boxed = UncheckedSendableBox(data)
        Task {
            do {
                let result = try await self.functions.executeCall(
                    targetSpec: self.targetSpec,
                    data: boxed,
                    options: self.options,
                    timeout: self.timeoutInterval
                )
                completion(result, nil)
            } catch {
                completion(nil, error)
            }
        }
    }

    /// Completion-handler overload executing this Callable HTTPS trigger with `nil` input data.
    public func call(
        completion: @escaping @Sendable (HTTPSCallableResult?, Error?) -> Void
    ) {
        call(nil, completion: completion)
    }

    /// Executes this Callable HTTPS trigger as an `Accept: text/event-stream` SSE stream,
    /// yielding `.message(Any)` chunks and a terminal `.result(HTTPSCallableResult)`.
    public func stream(
        _ data: Any? = nil
    ) -> AsyncThrowingStream<StreamResponse<Any, HTTPSCallableResult>, Error> {
        let boxed = UncheckedSendableBox(data)
        return functions.executeStream(
            targetSpec: targetSpec,
            data: boxed,
            options: options,
            timeout: timeoutInterval
        )
    }
}
