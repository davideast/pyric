import Foundation

/// Thread-safe registry allowing FirebaseAuth to automatically bind to Firestore without circular dependencies.
public final class AuthCredentialProviderRegistry: @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var factory: (@Sendable (FirebaseApp) -> (any AuthCredentialProvider)?)?
    nonisolated(unsafe) private static var instances: [String: any AuthCredentialProvider] = [:]
    nonisolated(unsafe) private static var observers: [UUID: @Sendable (String?) -> Void] = [:]

    public static var hasFactory: Bool {
        lock.lock()
        defer { lock.unlock() }
        return factory != nil
    }

    @discardableResult
    public static func addRegistrationObserver(
        _ observer: @escaping @Sendable (String?) -> Void
    ) -> UUID {
        let id = UUID()
        lock.lock()
        observers[id] = observer
        lock.unlock()
        return id
    }

    public static func removeRegistrationObserver(_ id: UUID) {
        lock.lock()
        observers.removeValue(forKey: id)
        lock.unlock()
    }

    private static func notifyObservers(appName: String?) {
        lock.lock()
        let snapshot = Array(observers.values)
        lock.unlock()
        for observer in snapshot {
            observer(appName)
        }
    }

    public static func registerFactory(_ factory: @escaping @Sendable (FirebaseApp) -> (any AuthCredentialProvider)?) {
        lock.lock()
        self.factory = factory
        lock.unlock()
        notifyObservers(appName: nil)
    }

    public static func register(app: FirebaseApp, provider: any AuthCredentialProvider) {
        lock.lock()
        instances[app.name] = provider
        lock.unlock()
        notifyObservers(appName: app.name)
    }

    public static func resolve(app: FirebaseApp) -> (any AuthCredentialProvider)? {
        let currentFactory: (@Sendable (FirebaseApp) -> (any AuthCredentialProvider)?)? = {
            lock.lock()
            defer { lock.unlock() }
            if let existing = instances[app.name] {
                return { _ in existing }
            }
            return factory
        }()
        guard let created = currentFactory?(app) else {
            return nil
        }
        lock.lock()
        defer { lock.unlock() }
        if let existing = instances[app.name] {
            return existing
        }
        instances[app.name] = created
        return created
    }

    public static func reset() {
        lock.lock()
        defer { lock.unlock() }
        instances.removeAll()
        factory = nil
    }
}
