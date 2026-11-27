import Foundation
import PyricFirestore

/// Upstream firebase-ios-sdk NSError domain and userInfo error-name key for FirebaseAuth.
public let AuthErrorDomain = "FIRAuthErrorDomain"
public let AuthErrorUserInfoNameKey = "FIRAuthErrorUserInfoNameKey"

/// Represents a structured Firebase Authentication error bridged to FIRAuthErrorDomain.
public struct AuthError: LocalizedError, CustomNSError, CustomStringConvertible, Sendable, Equatable {
    public static var errorDomain: String { AuthErrorDomain }

    public let code: AuthErrorCode
    public let message: String

    public init(code: AuthErrorCode, message: String) {
        self.code = code
        self.message = message
    }

    public var errorCode: Int {
        code.firErrorCode
    }

    public var errorUserInfo: [String: Any] {
        [
            NSLocalizedDescriptionKey: message,
            AuthErrorUserInfoNameKey: code.errorName,
        ]
    }

    public var errorDescription: String? {
        message
    }

    public var description: String {
        "[\(code.rawValue)] \(message)"
    }

    public static func from(error: Error) -> AuthError {
        if let authErr = error as? AuthError {
            return authErr
        }
        if let bridgeErr = error as? PyricBridgeError {
            let parsed = parseStructuredBlockingError(bridgeErr.message)
            var authCode = AuthErrorCode.from(codeString: bridgeErr.rawCode)
            if authCode == .internalError, let status = parsed.status {
                authCode = mapBlockingStatus(status)
            }
            return AuthError(code: authCode, message: parsed.message ?? bridgeErr.message)
        }
        return AuthError(code: .internalError, message: error.localizedDescription)
    }

    private static func parseStructuredBlockingError(_ raw: String) -> (message: String?, status: String?) {
        guard let start = raw.firstIndex(of: "{"),
              let end = raw.lastIndex(of: "}"),
              start < end else {
            return (nil, nil)
        }
        let slice = String(raw[start...end])
        guard let data = slice.data(using: .utf8),
              let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let inner = decoded["error"] as? [String: Any] else {
            return (nil, nil)
        }
        let rawMessage = (inner["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let message = (rawMessage?.isEmpty == false) ? rawMessage : nil
        let rawStatus = (inner["status"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let status = (rawStatus?.isEmpty == false) ? rawStatus : nil
        return (message, status)
    }

    private static func mapBlockingStatus(_ status: String) -> AuthErrorCode {
        switch status {
        case "PERMISSION_DENIED": return .permissionDenied
        case "UNAUTHENTICATED": return .unauthenticated
        case "INVALID_ARGUMENT": return .invalidArgument
        case "FAILED_PRECONDITION": return .failedPrecondition
        case "RESOURCE_EXHAUSTED": return .resourceExhausted
        case "ALREADY_EXISTS": return .alreadyExists
        case "NOT_FOUND": return .notFound
        case "UNAVAILABLE": return .unavailable
        case "DEADLINE_EXCEEDED": return .deadlineExceeded
        case "CANCELLED", "CANCELED": return .cancelled
        case "ABORTED": return .aborted
        default: return .internalError
        }
    }
}
