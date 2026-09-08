import Foundation
import PyricFirestore

open class AuthCredential: @unchecked Sendable {
    public let provider: String

    public init(provider: String) {
        self.provider = provider
    }

    internal func toWireParams() -> [String: AnySendable] {
        ["providerId": .string(provider)]
    }
}
