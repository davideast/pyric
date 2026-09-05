import Foundation

/// Thread-safe registry allowing FirebaseAuth to automatically bind to Firestore without circular dependencies.
public final class AuthCredentialProviderRegistry: @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var factory: (@Sendable (FirebaseApp) -> (any AuthCredentialProvider)?)?
    nonisolated(unsafe) private static var instances: [String: any AuthCredentialProvider] = [:]

    public static func registerFactory(_ factory: @escaping @Sendable (FirebaseApp) -> (any AuthCredentialProvider)?) {
        lock.lock()
        defer { lock.unlock() }
        self.factory = factory
    }

    public static func register(app: FirebaseApp, provider: any AuthCredentialProvider) {
        lock.lock()
        defer { lock.unlock() }
        instances[app.name] = provider
    }

    public static func resolve(app: FirebaseApp) -> (any AuthCredentialProvider)? {
        lock.lock()
        defer { lock.unlock() }
        if let existing = instances[app.name] {
            return existing
        }
        if let created = factory?(app) {
            instances[app.name] = created
            return created
        }
        return nil
    }

    public static func reset() {
        lock.lock()
        defer { lock.unlock() }
        instances.removeAll()
        factory = nil
    }
}
