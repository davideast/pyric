import Foundation
import PyricFirestore

/// Result of an ID token retrieval containing token string and token claims metadata.
public struct AuthTokenResult: Sendable, Equatable {
    public let token: String
    public let expirationDate: Date
    public let authDate: Date
    public let issuedAtDate: Date
    public let signInProvider: String?
    public let claims: [String: AnySendable]

    public init(
        token: String,
        expirationDate: Date,
        authDate: Date,
        issuedAtDate: Date,
        signInProvider: String? = nil,
        claims: [String: AnySendable] = [:]
    ) {
        self.token = token
        self.expirationDate = expirationDate
        self.authDate = authDate
        self.issuedAtDate = issuedAtDate
        self.signInProvider = signInProvider
        self.claims = claims
    }

    public static func fromWire(_ wire: [String: AnySendable]) -> AuthTokenResult {
        let token = wire["token"]?.stringValue ?? ""
        let signInProvider = wire["signInProvider"]?.stringValue
        let claims = wire["claims"]?.dictionaryValue ?? [:]

        let expStr = wire["expirationTime"]?.stringValue
        let authStr = wire["authTime"]?.stringValue
        let iatStr = wire["issuedAtTime"]?.stringValue

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        let fallbackFormatter = ISO8601DateFormatter()

        func parseDate(_ str: String?) -> Date {
            guard let str else { return Date() }
            if let d = formatter.date(from: str) { return d }
            if let d = fallbackFormatter.date(from: str) { return d }
            return Date()
        }

        return AuthTokenResult(
            token: token,
            expirationDate: parseDate(expStr),
            authDate: parseDate(authStr),
            issuedAtDate: parseDate(iatStr),
            signInProvider: signInProvider,
            claims: claims
        )
    }
}
