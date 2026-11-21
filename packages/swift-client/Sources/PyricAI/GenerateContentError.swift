import Foundation

/// Canonical gRPC status codes surfaced in Gemini backend error envelopes.
public enum RPCStatus: String, Sendable, Codable, Equatable, Hashable {
    case ok = "OK"
    case cancelled = "CANCELLED"
    case unknown = "UNKNOWN"
    case invalidArgument = "INVALID_ARGUMENT"
    case deadlineExceeded = "DEADLINE_EXCEEDED"
    case notFound = "NOT_FOUND"
    case alreadyExists = "ALREADY_EXISTS"
    case permissionDenied = "PERMISSION_DENIED"
    case unauthenticated = "UNAUTHENTICATED"
    case resourceExhausted = "RESOURCE_EXHAUSTED"
    case failedPrecondition = "FAILED_PRECONDITION"
    case aborted = "ABORTED"
    case outOfRange = "OUT_OF_RANGE"
    case unimplemented = "UNIMPLEMENTED"
    case internalError = "INTERNAL"
    case unavailable = "UNAVAILABLE"
    case dataLoss = "DATA_LOSS"

    package static func fromWireStatus(_ raw: String?) -> RPCStatus {
        guard let raw else { return .unknown }
        let normalized = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "ai/", with: "")
            .replacingOccurrences(of: "-", with: "_")
            .uppercased()
        return RPCStatus(rawValue: normalized) ?? .unknown
    }

    package var defaultHTTPStatusCode: Int {
        switch self {
        case .ok: return 200
        case .cancelled: return 499
        case .unknown: return 500
        case .invalidArgument: return 400
        case .deadlineExceeded: return 504
        case .notFound: return 404
        case .alreadyExists: return 409
        case .permissionDenied: return 403
        case .unauthenticated: return 401
        case .resourceExhausted: return 429
        case .failedPrecondition: return 400
        case .aborted: return 409
        case .outOfRange: return 400
        case .unimplemented: return 501
        case .internalError: return 500
        case .unavailable: return 503
        case .dataLoss: return 500
        }
    }
}

/// Structured Gemini HTTP/RPC backend error decoded from an `AiBrokerError` envelope.
public struct BackendError: Error, LocalizedError, CustomNSError, Sendable, Equatable, Decodable {
    public static let errorDomain = "com.google.firebase.FirebaseAI.BackendError"

    public let httpResponseCode: Int
    public let message: String
    public let status: RPCStatus
    public let details: [JSONObject]

    public init(
        httpResponseCode: Int,
        message: String,
        status: RPCStatus,
        details: [JSONObject] = []
    ) {
        self.httpResponseCode = httpResponseCode
        self.message = message
        self.status = status
        self.details = details
    }

    public var errorCode: Int { httpResponseCode }

    public var errorDescription: String? {
        "\(message) (\(Self.errorDomain) - HTTP \(httpResponseCode) \(status.rawValue))"
    }

    public var errorUserInfo: [String: Any] {
        [NSLocalizedDescriptionKey: errorDescription ?? message]
    }

    private struct WireErrorStatus: Decodable {
        let code: Int?
        let message: String?
        let status: String?
        let details: [JSONObject]?
    }

    enum CodingKeys: String, CodingKey {
        case error
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let wire = try container.decode(WireErrorStatus.self, forKey: .error)
        let parsedStatus = RPCStatus.fromWireStatus(wire.status)
        self.status = parsedStatus
        self.httpResponseCode = wire.code ?? parsedStatus.defaultHTTPStatusCode
        self.message = wire.message ?? "Unknown error."
        self.details = wire.details ?? []
    }
}

/// Thrown when a `Candidate` or stream carries no usable content or metadata.
public struct EmptyContentError: Error, LocalizedError, Sendable, Equatable {
    public init() {}

    public var errorDescription: String? {
        "The model response contained no usable candidate content."
    }
}

/// Errors thrown by `GenerativeModel` and `Chat` operations, mirroring `FirebaseAILogic.GenerateContentError` (`13.2.0`).
public enum GenerateContentError: Error, LocalizedError, Sendable {
    /// An internal, transport, or backend RPC error occurred.
    case internalError(underlying: any Error)

    /// An error occurred while preparing media/image input content.
    case promptImageContentError(underlying: any Error)

    /// The prompt was blocked before generation; inspect `response.promptFeedback?.blockReason`.
    case promptBlocked(response: GenerateContentResponse)

    /// Generation stopped before natural `.stop` completion; inspect `reason` and `response`.
    case responseStoppedEarly(reason: FinishReason, response: GenerateContentResponse)

    public var errorDescription: String? {
        switch self {
        case .internalError(let underlying):
            return underlying.localizedDescription
        case .promptImageContentError(let underlying):
            return underlying.localizedDescription
        case .promptBlocked(let response):
            if let reason = response.promptFeedback?.blockReason?.rawValue {
                return "Prompt was blocked due to \(reason)."
            }
            return "Prompt was blocked."
        case .responseStoppedEarly(let reason, let response):
            if let finishMsg = response.candidates.first?.finishMessage, !finishMsg.isEmpty {
                return "Response stopped early due to \(reason.rawValue): \(finishMsg)"
            }
            return "Response stopped early due to \(reason.rawValue)."
        }
    }

    package static func wrap(_ error: any Error) -> GenerateContentError {
        if let already = error as? GenerateContentError {
            return already
        }
        return .internalError(underlying: error)
    }
}
