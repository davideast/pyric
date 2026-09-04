import Foundation
import PyricFirestore

/// Auxiliary information returned with an authentication operation.
public struct AdditionalUserInfo: Sendable, Equatable {
    public let providerID: String?
    public let isNewUser: Bool
    public let profile: [String: AnySendable]?

    public init(
        providerID: String? = nil,
        isNewUser: Bool = false,
        profile: [String: AnySendable]? = nil
    ) {
        self.providerID = providerID
        self.isNewUser = isNewUser
        self.profile = profile
    }
}
