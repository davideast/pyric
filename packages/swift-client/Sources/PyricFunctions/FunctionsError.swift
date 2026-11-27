import Foundation

/// The error domain for codes in `FunctionsErrorCode`, matching `FirebaseFunctions.FunctionsErrorDomain`.
public let FunctionsErrorDomain: String = "com.firebase.functions"

/// The `NSError.userInfo` key holding decoded structured error details, matching `FirebaseFunctions.FunctionsErrorDetailsKey`.
public let FunctionsErrorDetailsKey: String = "details"

/// Canonical error status codes returned from Callable HTTPS triggers (`google.rpc.Code`),
/// matching `FirebaseFunctions.FunctionsErrorCode` (`13.2.0`).
public enum FunctionsErrorCode: Int, Sendable, Equatable, Hashable, CaseIterable {
    case OK = 0
    case cancelled = 1
    case unknown = 2
    case invalidArgument = 3
    case deadlineExceeded = 4
    case notFound = 5
    case alreadyExists = 6
    case permissionDenied = 7
    case resourceExhausted = 8
    case failedPrecondition = 9
    case aborted = 10
    case outOfRange = 11
    case unimplemented = 12
    case `internal` = 13
    case unavailable = 14
    case dataLoss = 15
    case unauthenticated = 16

    package init(httpStatusCode: Int) {
        if (200...299).contains(httpStatusCode) {
            self = .OK
            return
        }
        switch httpStatusCode {
        case 400: self = .invalidArgument
        case 401: self = .unauthenticated
        case 403: self = .permissionDenied
        case 404: self = .notFound
        case 409: self = .alreadyExists
        case 429: self = .resourceExhausted
        case 499: self = .cancelled
        case 500: self = .internal
        case 501: self = .unimplemented
        case 503: self = .unavailable
        case 504: self = .deadlineExceeded
        default: self = .internal
        }
    }

    package static func fromCanonicalStatus(_ status: String) -> FunctionsErrorCode? {
        switch status {
        case "OK": return .OK
        case "CANCELLED": return .cancelled
        case "UNKNOWN": return .unknown
        case "INVALID_ARGUMENT": return .invalidArgument
        case "DEADLINE_EXCEEDED": return .deadlineExceeded
        case "NOT_FOUND": return .notFound
        case "ALREADY_EXISTS": return .alreadyExists
        case "PERMISSION_DENIED": return .permissionDenied
        case "RESOURCE_EXHAUSTED": return .resourceExhausted
        case "FAILED_PRECONDITION": return .failedPrecondition
        case "ABORTED": return .aborted
        case "OUT_OF_RANGE": return .outOfRange
        case "UNIMPLEMENTED": return .unimplemented
        case "INTERNAL": return .internal
        case "UNAVAILABLE": return .unavailable
        case "DATA_LOSS": return .dataLoss
        case "UNAUTHENTICATED": return .unauthenticated
        default: return nil
        }
    }

    package var defaultDescription: String {
        switch self {
        case .OK: return "OK"
        case .cancelled: return "CANCELLED"
        case .unknown: return "UNKNOWN"
        case .invalidArgument: return "INVALID ARGUMENT"
        case .deadlineExceeded: return "DEADLINE EXCEEDED"
        case .notFound: return "NOT FOUND"
        case .alreadyExists: return "ALREADY EXISTS"
        case .permissionDenied: return "PERMISSION DENIED"
        case .resourceExhausted: return "RESOURCE EXHAUSTED"
        case .failedPrecondition: return "FAILED PRECONDITION"
        case .aborted: return "ABORTED"
        case .outOfRange: return "OUT OF RANGE"
        case .unimplemented: return "UNIMPLEMENTED"
        case .internal: return "INTERNAL"
        case .unavailable: return "UNAVAILABLE"
        case .dataLoss: return "DATA LOSS"
        case .unauthenticated: return "UNAUTHENTICATED"
        }
    }
}

/// Structured error thrown by `PyricFunctions`, bridging cleanly to `NSError` under
/// `FunctionsErrorDomain` on both Apple Darwin and Linux (`swift-corelibs-foundation`).
public struct FunctionsError: Error, LocalizedError, CustomNSError, CustomStringConvertible, @unchecked Sendable {
    public static var errorDomain: String {
        FunctionsErrorDomain
    }

    public let code: FunctionsErrorCode
    public let message: String
    public let details: Any?
    public let region: String?
    public let url: URL?
    public let underlyingError: (any Error)?

    public var errorCode: Int {
        code.rawValue
    }

    public var errorDescription: String? {
        message
    }

    public var failureReason: String? {
        message
    }

    public var errorUserInfo: [String: Any] {
        var info: [String: Any] = [
            NSLocalizedDescriptionKey: message
        ]
        if let details {
            info[FunctionsErrorDetailsKey] = details
        }
        if let region {
            info["region"] = region
        }
        if let url {
            info["url"] = url
        }
        if let underlyingError {
            info[NSUnderlyingErrorKey] = underlyingError
        }
        return info
    }

    public var description: String {
        "FunctionsError(code: \(code.rawValue), message: \(message))"
    }

    public init(
        _ code: FunctionsErrorCode,
        message: String? = nil,
        details: Any? = nil,
        region: String? = nil,
        url: URL? = nil,
        underlyingError: (any Error)? = nil
    ) {
        self.code = code
        self.message = message ?? code.defaultDescription
        self.details = details
        self.region = region
        self.url = url
        self.underlyingError = underlyingError
    }

    package static func fromResponse(
        httpStatusCode: Int,
        region: String,
        url: URL,
        body: Data?,
        serializer: FunctionsSerializer
    ) -> FunctionsError? {
        let defaultCode = FunctionsErrorCode(httpStatusCode: httpStatusCode)
        var parsedJSON: [String: Any]?
        if let body, !body.isEmpty {
            parsedJSON = (try? JSONSerialization.jsonObject(with: body, options: [])) as? [String: Any]
        }
        return fromErrorEnvelope(
            defaultCode: defaultCode,
            region: region,
            url: url,
            json: parsedJSON,
            serializer: serializer
        )
    }

    package static func fromErrorEnvelope(
        defaultCode: FunctionsErrorCode,
        region: String,
        url: URL,
        json: [String: Any]?,
        serializer: FunctionsSerializer
    ) -> FunctionsError? {
        var resolvedCode = defaultCode
        var resolvedMessage = defaultCode.defaultDescription
        var resolvedDetails: Any?

        if let errorObject = json?["error"] as? [String: Any] {
            if let rawStatus = errorObject["status"] as? String {
                guard let mapped = FunctionsErrorCode.fromCanonicalStatus(rawStatus) else {
                    return FunctionsError(
                        .internal,
                        message: FunctionsErrorCode.internal.defaultDescription,
                        region: region,
                        url: url
                    )
                }
                if mapped != .OK || defaultCode == .OK {
                    resolvedCode = mapped
                    resolvedMessage = mapped.defaultDescription
                }
            }

            if let customMessage = errorObject["message"] as? String {
                resolvedMessage = customMessage
            }

            if let rawDetails = errorObject["details"] {
                if let decoded = try? serializer.decode(rawDetails) {
                    resolvedDetails = decoded
                } else {
                    resolvedDetails = rawDetails
                }
            }
        }

        if resolvedCode == .OK {
            return nil
        }

        return FunctionsError(
            resolvedCode,
            message: resolvedMessage,
            details: resolvedDetails,
            region: region,
            url: url
        )
    }
}

public func ~= (lhs: FunctionsErrorCode, rhs: any Error) -> Bool {
    if let fnError = rhs as? FunctionsError {
        return fnError.code == lhs
    }
    let nsError = rhs as NSError
    return nsError.domain == FunctionsErrorDomain && nsError.code == lhs.rawValue
}
