import Foundation
import PyricFirestore

/// Initializes the FirebaseAuth subsystem and registers the credential provider with PyricFirestore.
public enum FirebaseAuthBootstrap {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var didRegister = false

    public static func initialize() {
        lock.lock()
        defer { lock.unlock() }
        guard !didRegister else { return }
        didRegister = true
        AuthCredentialProviderRegistry.registerFactory { app in
            Auth.auth(app: app)
        }
    }
}
