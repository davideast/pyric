import Foundation

/// Typed OAuth provider identifiers matching firebase-ios-sdk 13.x AuthProviderID.
public enum AuthProviderID: Sendable, Equatable {
    case apple
    case gitHub
    case google
    case custom(String)

    public var rawValue: String {
        switch self {
        case .apple: return "apple.com"
        case .gitHub: return "github.com"
        case .google: return "google.com"
        case .custom(let id): return id
        }
    }
}

public enum OAuthProvider {
    public static func credential(
        withProviderID providerID: String,
        idToken: String,
        rawNonce: String? = nil,
        accessToken: String? = nil
    ) -> OAuthCredential {
        OAuthCredential(providerID: providerID, idToken: idToken, rawNonce: rawNonce, accessToken: accessToken)
    }

    public static func credential(
        providerID: AuthProviderID,
        idToken: String,
        rawNonce: String? = nil,
        accessToken: String? = nil
    ) -> OAuthCredential {
        OAuthCredential(
            providerID: providerID.rawValue,
            idToken: idToken,
            rawNonce: rawNonce,
            accessToken: accessToken
        )
    }
}
