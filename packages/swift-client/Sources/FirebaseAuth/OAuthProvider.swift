import Foundation
import PyricFirestore

public final class OAuthCredential: AuthCredential, @unchecked Sendable {
    public let idToken: String?
    public let accessToken: String?
    public let rawNonce: String?

    public init(providerID: String, idToken: String?, rawNonce: String?, accessToken: String?) {
        self.idToken = idToken
        self.accessToken = accessToken
        self.rawNonce = rawNonce
        super.init(provider: providerID)
    }

    override internal func toWireParams() -> [String: AnySendable] {
        var params: [String: AnySendable] = ["providerId": .string(provider)]
        if let idToken { params["idToken"] = .string(idToken) }
        if let accessToken { params["accessToken"] = .string(accessToken) }
        if let rawNonce { params["rawNonce"] = .string(rawNonce) }
        return params
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
}
