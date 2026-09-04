import Foundation
import PyricFirestore

/// Concrete implementation of UserInfo for providerData items.
public struct UserInfoImpl: UserInfo, Sendable, Equatable {
    public let providerID: String
    public let uid: String
    public let displayName: String?
    public let photoURL: URL?
    public let email: String?
    public let phoneNumber: String?

    public init(
        providerID: String,
        uid: String,
        displayName: String? = nil,
        photoURL: URL? = nil,
        email: String? = nil,
        phoneNumber: String? = nil
    ) {
        self.providerID = providerID
        self.uid = uid
        self.displayName = displayName
        self.photoURL = photoURL
        self.email = email
        self.phoneNumber = phoneNumber
    }

    public static func fromWire(_ wire: [String: AnySendable]) -> UserInfoImpl {
        let providerID = wire["providerId"]?.stringValue ?? "password"
        let uid = wire["uid"]?.stringValue ?? ""
        let displayName = wire["displayName"]?.stringValue
        let photoURL = wire["photoURL"]?.stringValue.flatMap { URL(string: $0) }
        let email = wire["email"]?.stringValue
        let phoneNumber = wire["phoneNumber"]?.stringValue
        return UserInfoImpl(
            providerID: providerID,
            uid: uid,
            displayName: displayName,
            photoURL: photoURL,
            email: email,
            phoneNumber: phoneNumber
        )
    }
}
