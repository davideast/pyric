import Foundation

/// Protocol representing profile information for a user or linked authentication provider.
public protocol UserInfo: Sendable {
    var providerID: String { get }
    var uid: String { get }
    var displayName: String? { get }
    var photoURL: URL? { get }
    var email: String? { get }
    var phoneNumber: String? { get }
}
