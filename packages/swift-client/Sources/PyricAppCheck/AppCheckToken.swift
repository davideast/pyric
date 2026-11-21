import Foundation

/// An object representing a Firebase App Check token, mirroring `FIRAppCheckToken` (`AppCheckToken`).
public final class AppCheckToken: NSObject, @unchecked Sendable {
    /// A Firebase App Check JWT string.
    public let token: String

    /// The App Check token's expiration date in the device's local time.
    public let expirationDate: Date

    /// Expiration timestamp in epoch milliseconds.
    public var expireTimeMillis: Int64 {
        Int64((expirationDate.timeIntervalSince1970 * 1000.0).rounded())
    }

    public init(token: String, expirationDate: Date) {
        self.token = token
        self.expirationDate = expirationDate
        super.init()
    }

    public convenience init(token: String, expireTimeMillis: Int64) {
        self.init(
            token: token,
            expirationDate: Date(timeIntervalSince1970: TimeInterval(expireTimeMillis) / 1000.0)
        )
    }

    public override func isEqual(_ object: Any?) -> Bool {
        guard let other = object as? AppCheckToken else {
            return false
        }
        return token == other.token && expirationDate == other.expirationDate
    }

    public override var hash: Int {
        var hasher = Hasher()
        hasher.combine(token)
        hasher.combine(expirationDate)
        return hasher.finalize()
    }
}
