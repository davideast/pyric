import Foundation

/// Error domain matching `FIRFirestoreErrorDomain` (`FirestoreErrorDomain`) in `FirebaseFirestore`.
public let FirestoreErrorDomain = "FIRFirestoreErrorDomain"

/// Canonical Firebase and Pyric error codes.
public enum FirestoreErrorCode: String, Sendable, Codable, CaseIterable, ExpressibleByStringLiteral {
    case ok = "ok"
    case cancelled = "cancelled"
    case unknown = "unknown"
    case invalidArgument = "invalid-argument"
    case deadlineExceeded = "deadline-exceeded"
    case notFound = "not-found"
    case alreadyExists = "already-exists"
    case permissionDenied = "permission-denied"
    case resourceExhausted = "resource-exhausted"
    case failedPrecondition = "failed-precondition"
    case aborted = "aborted"
    case outOfRange = "out-of-range"
    case unimplemented = "unimplemented"
    case internalError = "internal"
    case unavailable = "unavailable"
    case dataLoss = "data-loss"
    case unauthenticated = "unauthenticated"

    /// Canonical gRPC / `FIRFirestoreErrorCode` integer value (`0..16`).
    public var grpcErrorCode: Int {
        switch self {
        case .ok: return 0
        case .cancelled: return 1
        case .unknown: return 2
        case .invalidArgument: return 3
        case .deadlineExceeded: return 4
        case .notFound: return 5
        case .alreadyExists: return 6
        case .permissionDenied: return 7
        case .resourceExhausted: return 8
        case .failedPrecondition: return 9
        case .aborted: return 10
        case .outOfRange: return 11
        case .unimplemented: return 12
        case .internalError: return 13
        case .unavailable: return 14
        case .dataLoss: return 15
        case .unauthenticated: return 16
        }
    }

    public init?(grpcErrorCode: Int) {
        switch grpcErrorCode {
        case 0: self = .ok
        case 1: self = .cancelled
        case 2: self = .unknown
        case 3: self = .invalidArgument
        case 4: self = .deadlineExceeded
        case 5: self = .notFound
        case 6: self = .alreadyExists
        case 7: self = .permissionDenied
        case 8: self = .resourceExhausted
        case 9: self = .failedPrecondition
        case 10: self = .aborted
        case 11: self = .outOfRange
        case 12: self = .unimplemented
        case 13: self = .internalError
        case 14: self = .unavailable
        case 15: self = .dataLoss
        case 16: self = .unauthenticated
        default: return nil
        }
    }

    public init(stringLiteral value: String) {
        self = FirestoreErrorCode(rawValue: value) ?? .unknown
    }

    public static func == (lhs: FirestoreErrorCode, rhs: String) -> Bool {
        lhs.rawValue == rhs
    }

    public static func == (lhs: String, rhs: FirestoreErrorCode) -> Bool {
        lhs == rhs.rawValue
    }
}

/// Structured error thrown on Pyric bridge RPC rejections, timeouts, or connection failures.
public struct PyricBridgeError: Error, CustomStringConvertible, LocalizedError, CustomNSError, Sendable, Equatable {
    public static var errorDomain: String {
        FirestoreErrorDomain
    }

    public let code: FirestoreErrorCode
    public let rawCode: String
    public let message: String
    public let denialContext: AnySendable?
    public let envelope: AnySendable?

    public var errorCode: Int {
        code.grpcErrorCode
    }

    public var errorUserInfo: [String: Any] {
        [NSLocalizedDescriptionKey: message]
    }

    public init(
        code: FirestoreErrorCode,
        rawCode: String? = nil,
        message: String,
        denialContext: AnySendable? = nil,
        envelope: AnySendable? = nil
    ) {
        self.code = code
        self.rawCode = rawCode ?? code.rawValue
        self.message = message
        self.denialContext = denialContext
        self.envelope = envelope
    }

    public var errorDescription: String? {
        message
    }

    public var description: String {
        // Keep structured denialContext on the property rather than dumping
        // raw expressionTrace payloads into user-facing error descriptions.
        return "PyricBridgeError(\(rawCode)): \(message)"
    }

    // -- Factory Helpers --

    public static func fromCode(
        code: String,
        message: String,
        denialContext: AnySendable? = nil,
        envelope: AnySendable? = nil
    ) -> PyricBridgeError {
        let errorCode = normalizeErrorCode(code: code, message: message)
        return PyricBridgeError(
            code: errorCode,
            rawCode: code,
            message: message,
            denialContext: denialContext,
            envelope: envelope
        )
    }

    private static func normalizeErrorCode(code: String, message: String) -> FirestoreErrorCode {
        if let exact = FirestoreErrorCode(rawValue: code), exact != .unknown {
            return exact
        }
        let kebabCode = code
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
        if let mapped = FirestoreErrorCode(rawValue: kebabCode), mapped != .unknown {
            return mapped
        }
        let kebabMsg = message
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
        if kebabMsg == "permission-denied" || kebabMsg.hasPrefix("permission-denied:") {
            return .permissionDenied
        }
        return FirestoreErrorCode(rawValue: code) ?? .unknown
    }

    public static func unavailable(_ message: String = "Service unavailable") -> PyricBridgeError {
        PyricBridgeError(code: .unavailable, message: message)
    }

    public static func unavailable(message: String) -> PyricBridgeError {
        unavailable(message)
    }

    public static func deadlineExceeded(_ message: String = "Deadline exceeded") -> PyricBridgeError {
        PyricBridgeError(code: .deadlineExceeded, message: message)
    }

    public static func deadlineExceeded(message: String) -> PyricBridgeError {
        deadlineExceeded(message)
    }

    public static func permissionDenied(_ message: String = "Permission denied", denialContext: AnySendable? = nil) -> PyricBridgeError {
        PyricBridgeError(code: .permissionDenied, message: message, denialContext: denialContext)
    }

    public static func permissionDenied(message: String, denialContext: AnySendable? = nil) -> PyricBridgeError {
        permissionDenied(message, denialContext: denialContext)
    }

    public static func notFound(_ message: String = "Not found") -> PyricBridgeError {
        PyricBridgeError(code: .notFound, message: message)
    }

    public static func notFound(message: String) -> PyricBridgeError {
        notFound(message)
    }

    public static func internalError(_ message: String = "Internal error") -> PyricBridgeError {
        PyricBridgeError(code: .internalError, message: message)
    }

    public static func internalError(message: String) -> PyricBridgeError {
        internalError(message)
    }

    public static func invalidArgument(_ message: String = "Invalid argument") -> PyricBridgeError {
        PyricBridgeError(code: .invalidArgument, message: message)
    }

    public static func invalidArgument(message: String) -> PyricBridgeError {
        invalidArgument(message)
    }
}

/// Generic client-side errors for PyricFirestore.
public enum PyricFirestoreError: Error, LocalizedError, CustomNSError, Equatable, Sendable {
    case invalidArgument(String)
    case serializationError(String)
    case deserializationError(String)
    case bridgeError(code: String, message: String)
    case connectionFailed(String)
    case cancelled
    case notFound(String)
    case alreadyExists(String)
    case permissionDenied(String)
    case internalError(String)

    public static var errorDomain: String {
        FirestoreErrorDomain
    }

    public var firestoreErrorCode: FirestoreErrorCode {
        switch self {
        case .invalidArgument, .serializationError:
            return .invalidArgument
        case .deserializationError, .internalError:
            return .internalError
        case .bridgeError(let code, let message):
            return PyricBridgeError.fromCode(code: code, message: message).code
        case .connectionFailed:
            return .unavailable
        case .cancelled:
            return .cancelled
        case .notFound:
            return .notFound
        case .alreadyExists:
            return .alreadyExists
        case .permissionDenied:
            return .permissionDenied
        }
    }

    public var errorCode: Int {
        firestoreErrorCode.grpcErrorCode
    }

    public var errorUserInfo: [String: Any] {
        [NSLocalizedDescriptionKey: errorDescription ?? "Firestore error"]
    }

    public var errorDescription: String? {
        switch self {
        case .invalidArgument(let msg): return "Invalid argument: \(msg)"
        case .serializationError(let msg): return "Serialization error: \(msg)"
        case .deserializationError(let msg): return "Deserialization error: \(msg)"
        case .bridgeError(let code, let msg): return "Bridge error [\(code)]: \(msg)"
        case .connectionFailed(let msg): return "Connection failed: \(msg)"
        case .cancelled: return "Operation cancelled"
        case .notFound(let msg): return "Not found: \(msg)"
        case .alreadyExists(let msg): return "Already exists: \(msg)"
        case .permissionDenied(let msg): return "Permission denied: \(msg)"
        case .internalError(let msg): return "Internal error: \(msg)"
        }
    }
}
