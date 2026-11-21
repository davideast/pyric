import Foundation
import PyricFirestore

/// Error domain matching `FIRAppCheckErrorDomain` in `FirebaseAppCheck`.
public let AppCheckErrorDomain = "com.firebase.appCheck"

/// Error type matching `NS_ERROR_ENUM(FIRAppCheckErrorDomain, FIRAppCheckErrorCode)` (`AppCheckErrorCode`).
///
/// Mirrors Swift's `NS_ERROR_ENUM` import shape so callers can match `catch AppCheckErrorCode.unsupported`,
/// `switch error { case AppCheckErrorCode.serverUnreachable: ... }`, and inspect `NSError` domain/code
/// identically on Darwin and Linux.
public struct AppCheckErrorCode: Error, LocalizedError, CustomNSError, CustomStringConvertible, Sendable, Hashable {
    public enum Code: Int, Sendable, Equatable, Hashable, CaseIterable {
        case unknown = 0
        case serverUnreachable = 1
        case invalidConfiguration = 2
        case keychain = 3
        case unsupported = 4
    }

    public static let unknown = AppCheckErrorCode(code: .unknown, message: "Unknown App Check error.")
    public static let serverUnreachable = AppCheckErrorCode(
        code: .serverUnreachable,
        message: "App Check server unreachable."
    )
    public static let invalidConfiguration = AppCheckErrorCode(
        code: .invalidConfiguration,
        message: "Invalid App Check configuration."
    )
    public static let keychain = AppCheckErrorCode(
        code: .keychain,
        message: "App Check keychain access error."
    )
    public static let unsupported = AppCheckErrorCode(
        code: .unsupported,
        message: "App Check provider is unsupported."
    )

    public let code: Code
    public let message: String
    public let underlyingDescription: String?

    public var rawValue: Int {
        code.rawValue
    }

    public init?(rawValue: Int) {
        guard let resolved = Code(rawValue: rawValue) else {
            return nil
        }
        self.code = resolved
        self.message = "App Check error (\(rawValue))."
        self.underlyingDescription = nil
    }

    public init(code: Code, message: String, underlyingDescription: String? = nil) {
        self.code = code
        self.message = message
        self.underlyingDescription = underlyingDescription
    }

    public static var errorDomain: String {
        AppCheckErrorDomain
    }

    public var errorCode: Int {
        code.rawValue
    }

    public var errorUserInfo: [String: Any] {
        var info: [String: Any] = [
            NSLocalizedDescriptionKey: message,
            NSLocalizedFailureReasonErrorKey: message
        ]
        if let underlyingDescription {
            info["PyricUnderlyingErrorDescription"] = underlyingDescription
        }
        return info
    }

    public var errorDescription: String? {
        message
    }

    public var failureReason: String? {
        message
    }

    public var description: String {
        "AppCheckError(code: \(code.rawValue), message: \(message))"
    }

    public static func == (lhs: AppCheckErrorCode, rhs: AppCheckErrorCode) -> Bool {
        lhs.code == rhs.code
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(code)
    }

    public static func from(_ error: Error) -> AppCheckErrorCode {
        if let existing = error as? AppCheckErrorCode {
            return existing
        }
        if let bridgeError = error as? PyricBridgeError {
            let mappedCode = mapBridgeCode(bridgeError.code)
            return AppCheckErrorCode(
                code: mappedCode,
                message: bridgeError.message,
                underlyingDescription: bridgeError.description
            )
        }
        let nsError = error as NSError
        if nsError.domain == AppCheckErrorDomain,
           let mapped = Code(rawValue: nsError.code) {
            return AppCheckErrorCode(
                code: mapped,
                message: nsError.localizedDescription
            )
        }
        return AppCheckErrorCode(
            code: .unknown,
            message: error.localizedDescription,
            underlyingDescription: String(describing: error)
        )
    }

    private static func mapBridgeCode(_ code: FirestoreErrorCode) -> Code {
        switch code {
        case .unavailable, .deadlineExceeded:
            return .serverUnreachable
        case .invalidArgument, .failedPrecondition:
            return .invalidConfiguration
        case .unimplemented:
            return .unsupported
        default:
            return .unknown
        }
    }
}

public typealias AppCheckError = AppCheckErrorCode

public func ~= (lhs: AppCheckErrorCode, rhs: any Error) -> Bool {
    if let structured = rhs as? AppCheckErrorCode {
        return lhs.code == structured.code
    }
    let nsError = rhs as NSError
    return nsError.domain == AppCheckErrorDomain && nsError.code == lhs.rawValue
}
