import Foundation

/// Protocol decoupling Firestore from concrete Authentication implementations.
public protocol AuthCredentialProvider: Sendable {
    /// Returns the active security rules evaluation lens.
    func currentAuthLens() -> AuthLens

    /// Real-time stream of security rules evaluation lenses, beginning with the current lens.
    var authLensStream: AsyncStream<AuthLens> { get }
}
