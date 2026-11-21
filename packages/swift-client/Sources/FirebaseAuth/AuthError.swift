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
            let authCode = AuthErrorCode.from(codeString: bridgeErr.rawCode)
            return AuthError(code: authCode, message: bridgeErr.message)
        }
        return AuthError(code: .internalError, message: error.localizedDescription)
    }
}
