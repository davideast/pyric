import Foundation
import PyricFirestore
@_exported import class PyricFirestore.FirebaseApp
@_exported import class PyricFirestore.FirebaseOptions

/// Initializes the FirebaseAuth subsystem and registers the credential provider with PyricFirestore.
public enum FirebaseAuthBootstrap {
    private static let lock = NSLock()

    public static func initialize() {
        lock.lock()
        defer { lock.unlock() }
        guard !AuthCredentialProviderRegistry.hasFactory else { return }
        AuthCredentialProviderRegistry.registerFactory { app in
            Auth.auth(app: app)
        }
    }
}
