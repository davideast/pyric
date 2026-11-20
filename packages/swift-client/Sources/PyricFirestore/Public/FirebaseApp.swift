import Foundation

/// Application container for Firebase SDK services, mirroring `FirebaseCore.FirebaseApp`.
public final class FirebaseApp: @unchecked Sendable, Equatable {
    public static let defaultAppName = "[DEFAULT]"

    public let name: String
    public let options: FirebaseOptions

    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var registeredApps: [String: FirebaseApp] = [:]

    private struct BridgeClientSpec: Equatable {
        let endpoint: URL
        let headers: [String: String]
    }

    private let bridgeLock = NSLock()
    private var _sharedBridgeClient: PyricBridgeClient?
    private var _sharedBridgeSpec: BridgeClientSpec?
    private var bridgeObservers: [UUID: @Sendable (PyricBridgeClient) -> Void] = [:]
    private let initialEnvironment: [String: String]

    public init(
        name: String = "[DEFAULT]",
        options: FirebaseOptions = FirebaseOptions(),
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.name = name
        self.options = options
        self.initialEnvironment = environment
    }

    // -- Static Configuration & Lookup --

    public static func configure() {
        configure(name: defaultAppName, options: FirebaseOptions())
    }

    public static func configure(options: FirebaseOptions) {
        configure(name: defaultAppName, options: options)
    }

    public static func configure(name: String, options: FirebaseOptions) {
        let created = FirebaseApp(name: name, options: options)
        let previous: FirebaseApp? = {
            registryLock.lock()
            defer { registryLock.unlock() }
            return registeredApps.updateValue(created, forKey: name)
        }()
        previous?.disconnectSharedBridgeInBackground()
    }

    public static func app() -> FirebaseApp {
        registryLock.lock()
        defer { registryLock.unlock() }
        if let existing = registeredApps[defaultAppName] {
            return existing
        }
        let created = FirebaseApp(name: defaultAppName, options: FirebaseOptions())
        registeredApps[defaultAppName] = created
        return created
    }

    public static func app(name: String) -> FirebaseApp? {
        registryLock.lock()
        defer { registryLock.unlock() }
        return registeredApps[name]
    }

    public static var allApps: [String: FirebaseApp]? {
        registryLock.lock()
        defer { registryLock.unlock() }
        return registeredApps.isEmpty ? nil : registeredApps
    }

    public func delete() async {
        let removed: Bool = {
            Self.registryLock.lock()
            defer { Self.registryLock.unlock() }
            if Self.registeredApps[name] === self {
                Self.registeredApps.removeValue(forKey: name)
                return true
            }
            return false
        }()
        _ = removed
        await disconnectSharedBridge()
    }

    public func delete(_ completion: @escaping @Sendable (Bool) -> Void) {
        Task {
            await self.delete()
            completion(true)
        }
    }

    public static func resetAppsForTesting() {
        let snapshot: [FirebaseApp] = {
            registryLock.lock()
            defer { registryLock.unlock() }
            let current = Array(registeredApps.values)
            registeredApps.removeAll()
            return current
        }()
        for app in snapshot {
            app.disconnectSharedBridgeInBackground()
        }
    }

    // -- Shared Bridge Client & Emulator Routing --

    public func sharedBridgeClient() -> PyricBridgeClient {
        bridgeLock.lock()
        defer { bridgeLock.unlock() }
        if let existing = _sharedBridgeClient {
            return existing
        }
        let resolved = FirebaseBridgeEndpointResolver.resolveDefault(environment: initialEnvironment)
        let headers = ["Host": resolved.hostHeader]
        let created = PyricBridgeClient(
            endpoint: resolved.endpoint,
            headers: headers
        )
        _sharedBridgeClient = created
        _sharedBridgeSpec = BridgeClientSpec(endpoint: resolved.endpoint, headers: headers)
        return created
    }

    package func adoptBridgeClientIfUnset(_ client: PyricBridgeClient) {
        bridgeLock.lock()
        defer { bridgeLock.unlock() }
        if _sharedBridgeClient == nil {
            _sharedBridgeClient = client
            _sharedBridgeSpec = nil
        }
    }

    @discardableResult
    public func useEmulator(withHost host: String, port: Int, sslEnabled: Bool = false) -> PyricBridgeClient {
        let resolved = FirebaseBridgeEndpointResolver.emulatorEndpoint(
            host: host,
            port: port,
            sslEnabled: sslEnabled
        )
        return reconfigureSharedBridge(
            endpoint: resolved.endpoint,
            headers: ["Host": resolved.hostHeader]
        )
    }

    @discardableResult
    public func reconfigureSharedBridge(endpoint: URL, headers: [String: String]) -> PyricBridgeClient {
        let desiredSpec = BridgeClientSpec(endpoint: endpoint, headers: headers)
        bridgeLock.lock()
        if let existing = _sharedBridgeClient, _sharedBridgeSpec == desiredSpec {
            bridgeLock.unlock()
            return existing
        }
        let next = PyricBridgeClient(endpoint: endpoint, headers: headers)
        let previous = _sharedBridgeClient
        _sharedBridgeClient = next
        _sharedBridgeSpec = desiredSpec
        let observers = Array(bridgeObservers.values)
        bridgeLock.unlock()

        if let previous {
            Task {
                await previous.disconnect()
            }
        }
        for observer in observers {
            observer(next)
        }
        return next
    }

    package func addBridgeObserver(_ observer: @escaping @Sendable (PyricBridgeClient) -> Void) -> UUID {
        let id = UUID()
        bridgeLock.lock()
        bridgeObservers[id] = observer
        bridgeLock.unlock()
        return id
    }

    package func removeBridgeObserver(_ id: UUID) {
        bridgeLock.lock()
        bridgeObservers.removeValue(forKey: id)
        bridgeLock.unlock()
    }

    public func disconnectSharedBridge() async {
        let existing: PyricBridgeClient? = {
            bridgeLock.lock()
            defer { bridgeLock.unlock() }
            let current = _sharedBridgeClient
            _sharedBridgeClient = nil
            _sharedBridgeSpec = nil
            return current
        }()
        if let existing {
            await existing.disconnect()
        }
    }

    private func disconnectSharedBridgeInBackground() {
        let existing: PyricBridgeClient? = {
            bridgeLock.lock()
            defer { bridgeLock.unlock() }
            let current = _sharedBridgeClient
            _sharedBridgeClient = nil
            _sharedBridgeSpec = nil
            return current
        }()
        if let existing {
            Task {
                await existing.disconnect()
            }
        }
    }

    public static func == (lhs: FirebaseApp, rhs: FirebaseApp) -> Bool {
        lhs.name == rhs.name && lhs.options == rhs.options
    }
}
