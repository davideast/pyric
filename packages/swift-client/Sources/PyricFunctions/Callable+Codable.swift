import Foundation

/// Encodes Swift `Encodable` values into Foundation JSON trees compatible with `FunctionsSerializer`,
/// mirroring `FirebaseSharedSwift.FirebaseDataEncoder`.
public final class FirebaseDataEncoder: @unchecked Sendable {
    public var dateEncodingStrategy: JSONEncoder.DateEncodingStrategy
    public var dataEncodingStrategy: JSONEncoder.DataEncodingStrategy
    public var keyEncodingStrategy: JSONEncoder.KeyEncodingStrategy

    public init(
        dateEncodingStrategy: JSONEncoder.DateEncodingStrategy = .deferredToDate,
        dataEncodingStrategy: JSONEncoder.DataEncodingStrategy = .base64,
        keyEncodingStrategy: JSONEncoder.KeyEncodingStrategy = .useDefaultKeys
    ) {
        self.dateEncodingStrategy = dateEncodingStrategy
        self.dataEncodingStrategy = dataEncodingStrategy
        self.keyEncodingStrategy = keyEncodingStrategy
    }

    public func encode<T: Encodable>(_ value: T) throws -> Any {
        if let boolVal = value as? Bool {
            return boolVal
        }
        if let intVal = value as? Int {
            return intVal
        }
        if let int64Val = value as? Int64 {
            return int64Val
        }
        if let uintVal = value as? UInt {
            return uintVal
        }
        if let uint64Val = value as? UInt64 {
            return uint64Val
        }
        if let doubleVal = value as? Double {
            guard doubleVal.isFinite else {
                throw EncodingError.invalidValue(
                    value,
                    EncodingError.Context(codingPath: [], debugDescription: "Non-finite Double cannot be encoded.")
                )
            }
            return doubleVal
        }
        if let floatVal = value as? Float {
            guard floatVal.isFinite else {
                throw EncodingError.invalidValue(
                    value,
                    EncodingError.Context(codingPath: [], debugDescription: "Non-finite Float cannot be encoded.")
                )
            }
            return Double(floatVal)
        }
        if let strVal = value as? String {
            return strVal
        }

        let jsonEncoder = JSONEncoder()
        jsonEncoder.dateEncodingStrategy = dateEncodingStrategy
        jsonEncoder.dataEncodingStrategy = dataEncodingStrategy
        jsonEncoder.keyEncodingStrategy = keyEncodingStrategy
        let jsonData = try jsonEncoder.encode(value)
        return try JSONSerialization.jsonObject(with: jsonData, options: [.fragmentsAllowed])
    }
}

/// Decodes Swift `Decodable` values from decoded callable response payloads,
/// mirroring `FirebaseSharedSwift.FirebaseDataDecoder`.
public final class FirebaseDataDecoder: @unchecked Sendable {
    public var dateDecodingStrategy: JSONDecoder.DateDecodingStrategy
    public var dataDecodingStrategy: JSONDecoder.DataDecodingStrategy
    public var keyDecodingStrategy: JSONDecoder.KeyDecodingStrategy

    public init(
        dateDecodingStrategy: JSONDecoder.DateDecodingStrategy = .deferredToDate,
        dataDecodingStrategy: JSONDecoder.DataDecodingStrategy = .base64,
        keyDecodingStrategy: JSONDecoder.KeyDecodingStrategy = .useDefaultKeys
    ) {
        self.dateDecodingStrategy = dateDecodingStrategy
        self.dataDecodingStrategy = dataDecodingStrategy
        self.keyDecodingStrategy = keyDecodingStrategy
    }

    public func decode<T: Decodable>(_ type: T.Type, from value: Any) throws -> T {
        let jsonData = try Self.serializeToJSONData(value)
        let jsonDecoder = JSONDecoder()
        jsonDecoder.dateDecodingStrategy = dateDecodingStrategy
        jsonDecoder.dataDecodingStrategy = dataDecodingStrategy
        jsonDecoder.keyDecodingStrategy = keyDecodingStrategy
        return try jsonDecoder.decode(type, from: jsonData)
    }

    private static func serializeToJSONData(_ value: Any) throws -> Data {
        if value is NSNull {
            return Data("null".utf8)
        }
        if let number = value as? NSNumber {
            let wrapped = try JSONSerialization.data(withJSONObject: [number], options: [])
            return unwrapSingleElementArrayJSON(wrapped)
        }
        if let boolVal = value as? Bool {
            return Data((boolVal ? "true" : "false").utf8)
        }
        if let intVal = value as? Int {
            return Data("\(intVal)".utf8)
        }
        if let int64Val = value as? Int64 {
            return Data("\(int64Val)".utf8)
        }
        if let uintVal = value as? UInt {
            return Data("\(uintVal)".utf8)
        }
        if let uint64Val = value as? UInt64 {
            return Data("\(uint64Val)".utf8)
        }
        if let doubleVal = value as? Double {
            guard doubleVal.isFinite else {
                throw DecodingError.dataCorrupted(
                    DecodingError.Context(codingPath: [], debugDescription: "Non-finite Double in decoded callable value.")
                )
            }
            return Data("\(doubleVal)".utf8)
        }
        if let strVal = value as? String {
            let wrapped = try JSONSerialization.data(withJSONObject: [strVal], options: [])
            return unwrapSingleElementArrayJSON(wrapped)
        }
        return try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
    }

    private static func unwrapSingleElementArrayJSON(_ data: Data) -> Data {
        guard data.count >= 2 else {
            return data
        }
        return data.subdata(in: 1..<(data.count - 1))
    }
}

private struct UncheckedCallableCallback: @unchecked Sendable {
    let invoke: (HTTPSCallableResult?, Error?) -> Void
}

/// Generic `Codable` wrapper around `HTTPSCallable`, matching `FirebaseFunctions.Callable` (`13.2.0`).
public struct Callable<Request: Encodable, Response: Decodable>: Sendable {
    private let callable: HTTPSCallable
    private let encoder: FirebaseDataEncoder
    private let decoder: FirebaseDataDecoder

    /// Request timeout in seconds when calling the function (defaults to `70.0`).
    public var timeoutInterval: TimeInterval {
        get { callable.timeoutInterval }
        nonmutating set { callable.timeoutInterval = newValue }
    }

    public init(
        callable: HTTPSCallable,
        encoder: FirebaseDataEncoder = FirebaseDataEncoder(),
        decoder: FirebaseDataDecoder = FirebaseDataDecoder()
    ) {
        self.callable = callable
        self.encoder = encoder
        self.decoder = decoder
    }

    /// Executes this typed Callable HTTPS trigger asynchronously.
    public func call(_ data: Request) async throws -> Response {
        let encoded = try encoder.encode(data)
        let result = try await callable.call(encoded)
        return try decoder.decode(Response.self, from: result.data)
    }

    /// Directly invokes this `Callable` like a Swift function (`try await greeter(request)`).
    public func callAsFunction(_ data: Request) async throws -> Response {
        try await call(data)
    }

    /// Completion-handler overload executing this typed Callable HTTPS trigger.
    public func call(
        _ data: Request,
        completion: @escaping @Sendable (Result<Response, Error>) -> Void
    ) {
        let encodedBox: UncheckedSendableBox
        do {
            encodedBox = UncheckedSendableBox(try encoder.encode(data))
        } catch {
            completion(.failure(error))
            return
        }
        let decoderRef = decoder
        let callback = UncheckedCallableCallback { result, error in
            if let error {
                completion(.failure(error))
                return
            }
            guard let result else {
                completion(.failure(FunctionsError(.internal, message: "Callable completed without result or error.")))
                return
            }
            do {
                let decoded = try decoderRef.decode(Response.self, from: result.data)
                completion(.success(decoded))
            } catch {
                completion(.failure(error))
            }
        }
        callable.call(encodedBox.value) { result, error in
            callback.invoke(result, error)
        }
    }

    /// Completion-handler `callAsFunction` overload.
    public func callAsFunction(
        _ data: Request,
        completion: @escaping @Sendable (Result<Response, Error>) -> Void
    ) {
        call(data, completion: completion)
    }
}

@available(macOS 14.0, iOS 17.0, watchOS 10.0, tvOS 17.0, *)
public extension Callable where Request == Never {
    /// Executes a parameterless Callable HTTPS trigger when `Request == Never`.
    func call() async throws -> Response {
        let result = try await callable.call(nil)
        return try decoder.decode(Response.self, from: result.data)
    }

    /// Directly invokes a parameterless `Callable` when `Request == Never`.
    func callAsFunction() async throws -> Response {
        try await call()
    }
}

public extension Callable where Request: Sendable, Response: Sendable {
    /// Streams responses from a streaming callable function (`Accept: text/event-stream`).
    ///
    /// When `Response` is `StreamResponse<Message, Result>`, yields both `.message(Message)`
    /// chunks and the terminal `.result(Result)`. Otherwise yields decoded `Response` chunks
    /// for each streamed message frame.
    func stream(_ data: Request? = nil) throws -> AsyncThrowingStream<Response, Error> {
        let encodedBox: UncheckedSendableBox
        do {
            if let data {
                encodedBox = UncheckedSendableBox(try encoder.encode(data))
            } else {
                encodedBox = UncheckedSendableBox(nil)
            }
        } catch {
            throw FunctionsError(
                .invalidArgument,
                message: FunctionsErrorCode.invalidArgument.defaultDescription,
                underlyingError: error
            )
        }

        let underlyingCallable = callable
        let decoderRef = decoder
        let expectsStreamResponseEnum = Response.self is any _FunctionsStreamResponseMarker.Type

        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let rawStream = underlyingCallable.stream(encodedBox.value)
                    for try await event in rawStream {
                        if expectsStreamResponseEnum {
                            let envelope: [String: Any]
                            switch event {
                            case .message(let chunk):
                                envelope = ["message": chunk]
                            case .result(let finalResult):
                                envelope = ["result": finalResult.data]
                            }
                            do {
                                let decoded = try decoderRef.decode(Response.self, from: envelope)
                                continuation.yield(decoded)
                            } catch let fnError as FunctionsError {
                                throw fnError
                            } catch {
                                throw FunctionsError(
                                    .dataLoss,
                                    message: FunctionsErrorCode.dataLoss.defaultDescription,
                                    underlyingError: error
                                )
                            }
                        } else {
                            guard case .message(let chunk) = event else {
                                continue
                            }
                            do {
                                let decoded = try decoderRef.decode(Response.self, from: chunk)
                                continuation.yield(decoded)
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
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }
}
