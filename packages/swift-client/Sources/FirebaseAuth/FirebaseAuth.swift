import Foundation
import PyricFirestore
@_exported import class PyricFirestore.FirebaseApp
@_exported import class PyricFirestore.FirebaseOptions

/// Initializes the FirebaseAuth subsystem and registers the credential provider with PyricFirestore.
public enum FirebaseAuthBootstrap {
    public static func initialize() {
        _ = AuthCredentialProviderRegistry.registerFactoryIfAbsent { app in
            Auth.auth(app: app)
        }
    }
}
