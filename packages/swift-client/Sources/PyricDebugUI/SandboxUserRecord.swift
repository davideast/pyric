import Foundation
import PyricFirestore

/// Represents an available sandbox user returned from the `auth.listUsers` RPC.
public struct SandboxUserRecord: Identifiable, Sendable, Hashable {
    public let uid: String
    public let email: String?
    public let displayName: String?
    public let photoURL: String?
    public let tenantId: String?
    public let customClaims: [String: AnySendable]

    public var id: String { uid }

    public init(
        uid: String,
        email: String? = nil,
        displayName: String? = nil,
        photoURL: String? = nil,
        tenantId: String? = nil,
        customClaims: [String: AnySendable] = [:]
    ) {
        self.uid = uid
        self.email = email
        self.displayName = displayName
        self.photoURL = photoURL
        self.tenantId = tenantId
        self.customClaims = customClaims
    }

    /// Parses a sandbox user record from bridge JSON wire format.
    public static func fromWire(_ wire: AnySendable) -> SandboxUserRecord? {
        guard let dict = wire.dictionaryValue,
              let uid = dict["uid"]?.stringValue, !uid.isEmpty else {
            return nil
        }
        let email = dict["email"]?.stringValue
        let displayName = dict["displayName"]?.stringValue
        let photoURL = dict["photoURL"]?.stringValue
        let tenantId = dict["tenantId"]?.stringValue ?? dict["tenant"]?.stringValue
        let claims = dict["customClaims"]?.dictionaryValue ?? dict["claims"]?.dictionaryValue ?? [:]

        return SandboxUserRecord(
            uid: uid,
            email: email,
            displayName: displayName,
            photoURL: photoURL,
            tenantId: tenantId,
            customClaims: claims
        )
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(uid)
    }

    public static func == (lhs: SandboxUserRecord, rhs: SandboxUserRecord) -> Bool {
        lhs.uid == rhs.uid
    }
}
