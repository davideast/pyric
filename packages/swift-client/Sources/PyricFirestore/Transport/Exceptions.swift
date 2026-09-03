import Foundation

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
public struct PyricBridgeError: Error, CustomStringConvertible, LocalizedError, Sendable, Equatable {
    public let code: FirestoreErrorCode
    public let rawCode: String
    public let message: String
    public let denialContext: AnySendable?
    public let envelope: AnySendable?

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
        if let denialContext {
            return "PyricBridgeError(\(rawCode)): \(message) [denialContext: \(denialContext)]"
        }
        return "PyricBridgeError(\(rawCode)): \(message)"
    }

    // ─── Factory Helpers ─────────────────────────────────────────────────────

    public static func fromCode(
        code: String,
        message: String,
        denialContext: AnySendable? = nil,
        envelope: AnySendable? = nil
    ) -> PyricBridgeError {
        let errorCode = FirestoreErrorCode(rawValue: code) ?? .unknown
        return PyricBridgeError(
            code: errorCode,
            rawCode: code,
            message: message,
            denialContext: denialContext,
            envelope: envelope
        )
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
public enum PyricFirestoreError: Error, LocalizedError, Equatable, Sendable {
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
