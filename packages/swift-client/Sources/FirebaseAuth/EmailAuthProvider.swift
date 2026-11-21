import Foundation
import PyricFirestore

/// Credential representing an email and password authentication factor.
public final class EmailAuthCredential: AuthCredential, @unchecked Sendable {
    public let email: String
    public let password: String

    public init(email: String, password: String) {
        self.email = email
        self.password = password
        super.init(provider: EmailAuthProvider.id)
    }

    override internal func toWireParams() -> [String: AnySendable] {
        [
            "providerId": .string(provider),
            "signInMethod": .string(EmailAuthProvider.emailPasswordSignInMethod),
            "email": .string(email),
            "password": .string(password),
        ]
    }
}

/// Factory for email and password authentication credentials matching firebase-ios-sdk.
public enum EmailAuthProvider {
    public static let id = "password"
    public static let providerID = "password"
    public static let emailPasswordSignInMethod = "password"

    public static func credential(withEmail email: String, password: String) -> EmailAuthCredential {
        EmailAuthCredential(email: email, password: password)
    }
}
