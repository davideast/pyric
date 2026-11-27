import Foundation
import PyricFirestore

/// Canonical Firebase Auth error codes and FIRAuthErrorDomain integer/name mappings.
public enum AuthErrorCode: String, Sendable, Error, CaseIterable {
    case invalidEmail = "auth/invalid-email"
    case wrongPassword = "auth/wrong-password"
    case userNotFound = "auth/user-not-found"
    case userDisabled = "auth/user-disabled"
    case userTokenExpired = "auth/user-token-expired"
    case emailAlreadyInUse = "auth/email-already-in-use"
    case accountExistsWithDifferentCredential = "auth/account-exists-with-different-credential"
    case credentialAlreadyInUse = "auth/credential-already-in-use"
    case providerAlreadyLinked = "auth/provider-already-linked"
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
    case permissionDenied = "auth/permission-denied"
    case unauthenticated = "auth/unauthenticated"
    case invalidArgument = "auth/invalid-argument"
    case failedPrecondition = "auth/failed-precondition"
    case resourceExhausted = "auth/resource-exhausted"
    case alreadyExists = "auth/already-exists"
    case notFound = "auth/not-found"
    case unavailable = "auth/unavailable"
    case deadlineExceeded = "auth/deadline-exceeded"
    case cancelled = "auth/cancelled"
    case aborted = "auth/aborted"
    case internalError = "auth/internal-error"

    /// Upstream firebase-ios-sdk FIRAuthErrorCode integer rawValue.
    public var firErrorCode: Int {
        switch self {
        case .invalidCustomToken: return 17000
        case .customTokenMismatch: return 17002
        case .invalidCredential, .noMockConfigured: return 17004
        case .userDisabled: return 17005
        case .operationNotAllowed: return 17006
        case .emailAlreadyInUse: return 17007
        case .invalidEmail: return 17008
        case .wrongPassword: return 17009
        case .tooManyRequests: return 17010
        case .userNotFound: return 17011
        case .accountExistsWithDifferentCredential: return 17012
        case .requiresRecentLogin: return 17014
        case .providerAlreadyLinked: return 17015
        case .networkError: return 17020
        case .userTokenExpired: return 17021
        case .userMismatch: return 17024
        case .credentialAlreadyInUse: return 17025
        case .weakPassword: return 17026
        case .noCurrentUser: return 17995
        case .permissionDenied,
             .unauthenticated,
             .invalidArgument,
             .failedPrecondition,
             .resourceExhausted,
             .alreadyExists,
             .notFound,
             .unavailable,
             .deadlineExceeded,
             .cancelled,
             .aborted,
             .internalError: return 17999
        }
    }

    /// Upstream firebase-ios-sdk AuthErrorUserInfoNameKey symbolic name.
    public var errorName: String {
        switch self {
        case .invalidCustomToken: return "ERROR_INVALID_CUSTOM_TOKEN"
        case .customTokenMismatch: return "ERROR_CUSTOM_TOKEN_MISMATCH"
        case .invalidCredential, .noMockConfigured: return "ERROR_INVALID_CREDENTIAL"
        case .userDisabled: return "ERROR_USER_DISABLED"
        case .operationNotAllowed: return "ERROR_OPERATION_NOT_ALLOWED"
        case .emailAlreadyInUse: return "ERROR_EMAIL_ALREADY_IN_USE"
        case .invalidEmail: return "ERROR_INVALID_EMAIL"
        case .wrongPassword: return "ERROR_WRONG_PASSWORD"
        case .tooManyRequests: return "ERROR_TOO_MANY_REQUESTS"
        case .userNotFound: return "ERROR_USER_NOT_FOUND"
        case .accountExistsWithDifferentCredential:
            return "ERROR_ACCOUNT_EXISTS_WITH_DIFFERENT_CREDENTIAL"
        case .requiresRecentLogin: return "ERROR_REQUIRES_RECENT_LOGIN"
        case .providerAlreadyLinked: return "ERROR_PROVIDER_ALREADY_LINKED"
        case .networkError: return "ERROR_NETWORK_REQUEST_FAILED"
        case .userTokenExpired: return "ERROR_USER_TOKEN_EXPIRED"
        case .userMismatch: return "ERROR_USER_MISMATCH"
        case .credentialAlreadyInUse: return "ERROR_CREDENTIAL_ALREADY_IN_USE"
        case .weakPassword: return "ERROR_WEAK_PASSWORD"
        case .noCurrentUser: return "ERROR_NO_CURRENT_USER"
        case .permissionDenied: return "ERROR_PERMISSION_DENIED"
        case .unauthenticated: return "ERROR_UNAUTHENTICATED"
        case .invalidArgument: return "ERROR_INVALID_ARGUMENT"
        case .failedPrecondition: return "ERROR_FAILED_PRECONDITION"
        case .resourceExhausted: return "ERROR_RESOURCE_EXHAUSTED"
        case .alreadyExists: return "ERROR_ALREADY_EXISTS"
        case .notFound: return "ERROR_NOT_FOUND"
        case .unavailable: return "ERROR_UNAVAILABLE"
        case .deadlineExceeded: return "ERROR_DEADLINE_EXCEEDED"
        case .cancelled: return "ERROR_CANCELLED"
        case .aborted: return "ERROR_ABORTED"
        case .internalError: return "ERROR_INTERNAL_ERROR"
        }
    }

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
        case "provider-already-linked": return .providerAlreadyLinked
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
        case "permission-denied", "permission_denied": return .permissionDenied
        case "unauthenticated": return .unauthenticated
        case "invalid-argument", "invalid_argument": return .invalidArgument
        case "failed-precondition", "failed_precondition": return .failedPrecondition
        case "resource-exhausted", "resource_exhausted": return .resourceExhausted
        case "already-exists", "already_exists": return .alreadyExists
        case "not-found", "not_found": return .notFound
        case "unavailable": return .unavailable
        case "deadline-exceeded", "deadline_exceeded": return .deadlineExceeded
        case "cancelled", "canceled": return .cancelled
        case "aborted": return .aborted
        default: return .internalError
        }
    }

    public static func from(error: Error) -> AuthErrorCode {
        if let authErr = error as? AuthError {
            return authErr.code
        }
        if error is PyricBridgeError {
            return AuthError.from(error: error).code
        }
        return .internalError
    }
}
