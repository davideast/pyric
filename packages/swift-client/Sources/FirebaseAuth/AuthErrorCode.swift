import Foundation
import PyricFirestore

/// Canonical Firebase Auth error codes.
public enum AuthErrorCode: String, Sendable, Error, CaseIterable {
    case invalidEmail = "auth/invalid-email"
    case wrongPassword = "auth/wrong-password"
    case userNotFound = "auth/user-not-found"
    case userDisabled = "auth/user-disabled"
    case emailAlreadyInUse = "auth/email-already-in-use"
    case weakPassword = "auth/weak-password"
    case operationNotAllowed = "auth/operation-not-allowed"
    case requiresRecentLogin = "auth/requires-recent-login"
    case networkError = "auth/network-request-failed"
    case userMismatch = "auth/user-mismatch"
    case invalidCredential = "auth/invalid-credential"
    case noCurrentUser = "auth/no-current-user"
    case internalError = "auth/internal-error"

    public static func from(codeString: String) -> AuthErrorCode {
        if let direct = AuthErrorCode(rawValue: codeString) {
            return direct
        }
        let stripped = codeString.hasPrefix("auth/") ? codeString : "auth/\(codeString)"
        if let direct = AuthErrorCode(rawValue: stripped) {
            return direct
        }
        switch codeString {
        case "invalid-email": return .invalidEmail
        case "wrong-password": return .wrongPassword
        case "user-not-found": return .userNotFound
        case "user-disabled": return .userDisabled
        case "email-already-in-use": return .emailAlreadyInUse
        case "weak-password": return .weakPassword
        case "operation-not-allowed": return .operationNotAllowed
        case "requires-recent-login": return .requiresRecentLogin
        case "network-request-failed": return .networkError
        case "invalid-credential": return .invalidCredential
        case "no-current-user": return .noCurrentUser
        default: return .internalError
        }
    }

    public static func from(error: Error) -> AuthErrorCode {
        if let authErr = error as? AuthError {
            return authErr.code
        }
        if let bridgeErr = error as? PyricBridgeError {
            return from(codeString: bridgeErr.rawCode)
        }
        return .internalError
    }
}
