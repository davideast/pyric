import Foundation

/// Result object returned upon successful user authentication.
public final class AuthDataResult: @unchecked Sendable {
    public let user: User
    public let additionalUserInfo: AdditionalUserInfo?

    public init(user: User, additionalUserInfo: AdditionalUserInfo? = nil) {
        self.user = user
        self.additionalUserInfo = additionalUserInfo
    }
}
