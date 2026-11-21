import Foundation
import PyricFirestore

/// Account creation and last sign-in timestamps associated with a Firebase Auth User.
public struct UserMetadata: Sendable, Equatable {
    public let creationDate: Date?
    public let lastSignInDate: Date?

    public init(creationDate: Date? = Date(), lastSignInDate: Date? = Date()) {
        self.creationDate = creationDate
        self.lastSignInDate = lastSignInDate
    }

    internal static func fromWire(_ wire: [String: AnySendable]?, fallbackDate: Date = Date()) -> UserMetadata {
        guard let wire else {
            return UserMetadata(creationDate: fallbackDate, lastSignInDate: fallbackDate)
        }
        let creation = parseTimestamp(wire["creationTime"]) ?? fallbackDate
        let lastSignIn = parseTimestamp(wire["lastSignInTime"]) ?? fallbackDate
        return UserMetadata(creationDate: creation, lastSignInDate: lastSignIn)
    }

    private static func parseTimestamp(_ raw: AnySendable?) -> Date? {
        guard let raw else { return nil }
        if let millis = raw.doubleValue {
            return Date(timeIntervalSince1970: millis / 1000.0)
        }
        if let str = raw.stringValue {
            if let millis = Double(str) {
                return Date(timeIntervalSince1970: millis / 1000.0)
            }
            let isoFrac = ISO8601DateFormatter()
            isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let parsed = isoFrac.date(from: str) {
                return parsed
            }
            let isoBasic = ISO8601DateFormatter()
            if let parsed = isoBasic.date(from: str) {
                return parsed
            }
        }
        return nil
    }
}
