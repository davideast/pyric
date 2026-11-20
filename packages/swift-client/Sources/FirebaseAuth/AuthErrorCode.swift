import Foundation
import PyricFirestore

/// Canonical Firebase Auth error codes.
public enum AuthErrorCode: String, Sendable, Error, CaseIterable {
    case invalidEmail = "auth/invalid-email"
    case wrongPassword = "auth/wrong-password"
    case userNotFound = "auth/user-not-found"
    case userDisabled = "auth/user-disabled"
    case userTokenExpired = "auth/user-token-expired"
    case emailAlreadyInUse = "auth/email-already-in-use"
    case accountExistsWithDifferentCredential = "auth/account-exists-with-different-credential"
    case credentialAlreadyInUse = "auth/credential-already-in-use"
    case weakPassword = "auth/weak-password"
    case operationNotAllowed = "auth/operation-not-allowed"
    case requiresRecentLogin = "auth/requires-recent-login"
    case tooManyRequests = "auth/too-many-requests"
    case networkError = "auth/network-request-failed"
    case userMismatch = "auth/user-mismatch"
    case invalidCredential = "auth/invalid-credential"
    case invalidCustomToken = "auth/invalid-custom-token"
    case customTokenMismatch = "auth/custom-token-mismatch"
    case noMockConfigured = "auth/no-mock-configured"
    case noCurrentUser = "auth/no-current-user"
    case internalError = "auth/internal-error"

    public static func from(codeString: String) -> AuthErrorCode {
        let normalized = codeString.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let direct = AuthErrorCode(rawValue: normalized) {
            return direct
        }
        let prefixed = normalized.hasPrefix("auth/") ? normalized : "auth/\(normalized)"
        if let direct = AuthErrorCode(rawValue: prefixed) {
            return direct
        }
        switch normalized {
        case "invalid-email": return .invalidEmail
        case "wrong-password": return .wrongPassword
        case "user-not-found": return .userNotFound
        case "user-disabled": return .userDisabled
        case "user-token-expired": return .userTokenExpired
        case "email-already-in-use": return .emailAlreadyInUse
        case "account-exists-with-different-credential": return .accountExistsWithDifferentCredential
        case "credential-already-in-use": return .credentialAlreadyInUse
        case "weak-password": return .weakPassword
        case "operation-not-allowed": return .operationNotAllowed
        case "requires-recent-login": return .requiresRecentLogin
        case "too-many-requests": return .tooManyRequests
        case "network-request-failed": return .networkError
        case "user-mismatch": return .userMismatch
        case "invalid-credential": return .invalidCredential
        case "invalid-custom-token": return .invalidCustomToken
        case "custom-token-mismatch": return .customTokenMismatch
        case "no-mock-configured": return .noMockConfigured
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
