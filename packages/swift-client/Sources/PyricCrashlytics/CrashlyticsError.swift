import Foundation
import PyricFirestore

/// Error domain emitted by `PyricCrashlytics` synchronization helpers (`flush()`, `getState()`).
public let CrashlyticsErrorDomain = "com.google.firebase.crashlytics"

/// Error codes thrown by `PyricCrashlytics` wire synchronization operations.
public enum CrashlyticsErrorCode: Int, Sendable, Equatable {
    case unknown = -1
    case invalidArgument = -2
    case network = -3
    case cancelled = -4
}

/// Structured error surfaced by `PyricCrashlytics` when a wire synchronization operation fails.
public struct CrashlyticsError: Error, LocalizedError, CustomNSError, Equatable, Sendable {
    public static var errorDomain: String { CrashlyticsErrorDomain }

    public let code: CrashlyticsErrorCode
    public let message: String
    public let wireCode: String?

    public var errorCode: Int { code.rawValue }

    public var errorDescription: String? { message }

    public var errorUserInfo: [String: Any] {
        var info: [String: Any] = [NSLocalizedDescriptionKey: message]
        if let wireCode {
            info["FIRCrashlyticsWireErrorCode"] = wireCode
        }
        return info
    }

    public init(
        code: CrashlyticsErrorCode,
        message: String,
        wireCode: String? = nil
    ) {
        self.code = code
        self.message = message
        self.wireCode = wireCode
    }

    package static func from(_ error: any Error) -> CrashlyticsError {
        if let existing = error as? CrashlyticsError {
            return existing
        }
        if error is CancellationError {
            return CrashlyticsError(
                code: .cancelled,
                message: "Crashlytics operation was cancelled."
            )
        }
        if let bridgeError = error as? PyricBridgeError {
            let mappedCode: CrashlyticsErrorCode
            let lower = bridgeError.code.rawValue.lowercased()
            if lower.contains("invalid-argument") {
                mappedCode = .invalidArgument
            } else if lower.contains("cancelled") {
                mappedCode = .cancelled
            } else if lower.contains("unavailable") || lower.contains("deadline") {
                mappedCode = .network
            } else {
                mappedCode = .unknown
            }
            return CrashlyticsError(
                code: mappedCode,
                message: bridgeError.message,
                wireCode: bridgeError.code.rawValue
            )
        }
        return CrashlyticsError(
            code: .unknown,
            message: String(describing: error)
        )
    }
}
