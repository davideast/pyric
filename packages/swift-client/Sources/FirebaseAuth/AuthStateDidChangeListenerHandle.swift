import Foundation

/// Token handle returned when adding an auth state or ID token listener.
public struct AuthStateDidChangeListenerHandle: Hashable, Sendable {
    public let id: UUID

    public init(id: UUID = UUID()) {
        self.id = id
    }
}
