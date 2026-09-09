import Foundation

public enum GoogleAuthProvider {
    public static let providerID = "google.com"

    public static func credential(withIDToken idToken: String, accessToken: String) -> AuthCredential {
        OAuthCredential(providerID: providerID, idToken: idToken, rawNonce: nil, accessToken: accessToken)
    }
}
