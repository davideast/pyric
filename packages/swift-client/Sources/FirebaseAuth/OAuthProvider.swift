import Foundation

public enum OAuthProvider {
    public static func credential(
        withProviderID providerID: String,
        idToken: String,
        rawNonce: String? = nil,
        accessToken: String? = nil
    ) -> OAuthCredential {
        OAuthCredential(providerID: providerID, idToken: idToken, rawNonce: rawNonce, accessToken: accessToken)
    }
}
