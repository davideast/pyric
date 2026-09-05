import Foundation
import PyricFirestore

/// Represents a structured Firebase Authentication error.
public struct AuthError: LocalizedError, CustomStringConvertible, Sendable, Equatable {
    public let code: AuthErrorCode
    public let message: String

    public init(code: AuthErrorCode, message: String) {
        self.code = code
        self.message = message
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
