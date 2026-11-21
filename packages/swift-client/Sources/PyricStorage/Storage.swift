import Foundation
import PyricFirestore

/// Entry point for the Firebase Cloud Storage Swift SDK (`PyricStorage`), mirroring `FirebaseStorage 13.2.0`.
public final class Storage: NSObject, @unchecked Sendable {
    private static let minChunkSizeUnit: Int64 = 262_144

    private struct InstanceKey: Hashable {
        let appName: String
        let bucket: String
    }

    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var instances: [InstanceKey: Storage] = [:]

    public let app: FirebaseApp
    package let storageBucket: String
    package let isNamedBucket: Bool
    package let configuredDefaultBucket: String?

    private let usesAppBridge: Bool
    private let stateLock = NSLock()
    private var _bridgeClient: PyricBridgeClient
    private var bridgeObserverID: UUID?
    private var _emulatorHost: String?
    private var _emulatorPort: Int?
    private var _hasUsed = false
    private var _maxUploadRetryTime: TimeInterval = 600.0
    private var _maxDownloadRetryTime: TimeInterval = 600.0
    private var _maxOperationRetryTime: TimeInterval = 120.0
    private var _uploadChunkSizeBytes: Int64 = .max
    private var _callbackQueue: DispatchQueue = .main
    private var _impersonatedLens: AuthLens?
    private var _credentialProvider: (any AuthCredentialProvider)?

    @available(*, unavailable, message: "Use Storage.storage() or Storage.storage(app:).")
    override public init() {
        fatalError("Storage cannot be initialized directly with init().")
    }

    package init(
        app: FirebaseApp,
        storageBucket: String,
        isNamedBucket: Bool,
        configuredDefaultBucket: String?,
        bridgeClient: PyricBridgeClient? = nil
    ) {
        self.app = app
        self.storageBucket = storageBucket
        self.isNamedBucket = isNamedBucket
        self.configuredDefaultBucket = configuredDefaultBucket
        self.usesAppBridge = (bridgeClient == nil)
        self._bridgeClient = bridgeClient ?? app.sharedBridgeClient()
        super.init()

        if usesAppBridge {
            self.bridgeObserverID = app.addBridgeObserver { [weak self] nextClient in
                self?.adoptObservedAppBridge(nextClient)
            }
        }
    }

    deinit {
        detachBridgeObserver()
    }

    // MARK: - Static Factory & Instance Cache

    /// Returns the `Storage` instance for the default `FirebaseApp`.
    public static func storage() -> Storage {
        storage(app: FirebaseApp.app())
    }

    /// Returns the `Storage` instance for the specified `FirebaseApp`.
    public static func storage(app: FirebaseApp) -> Storage {
        let resolved = resolveDefaultBucket(for: app)
        return cachedOrCreate(
            app: app,
            bucket: resolved.bucket,
            isNamedBucket: false,
            configuredDefaultBucket: resolved.wireDefaultBucket,
            bridgeClient: nil
        )
    }

    /// Returns a `Storage` instance for the default `FirebaseApp` and custom `gs://` bucket URL.
    public static func storage(url: String) -> Storage {
        storage(app: FirebaseApp.app(), url: url)
    }

    /// Returns a `Storage` instance for the specified `FirebaseApp` and custom `gs://` bucket URL.
    public static func storage(app: FirebaseApp, url: String) -> Storage {
        do {
            return try validatedStorage(app: app, url: url, bridgeClient: nil)
        } catch {
            preconditionFailure(error.localizedDescription)
        }
    }

    /// Returns or creates a `Storage` instance bound to an explicit `PyricBridgeClient` for testing.
    public static func storage(app: FirebaseApp, bridgeClient: PyricBridgeClient) -> Storage {
        let resolved = resolveDefaultBucket(for: app)
        return cachedOrCreate(
            app: app,
            bucket: resolved.bucket,
            isNamedBucket: false,
            configuredDefaultBucket: resolved.wireDefaultBucket,
            bridgeClient: bridgeClient
        )
    }

    /// Returns or creates a `Storage` instance for a custom `gs://` bucket URL bound to `bridgeClient`.
    public static func storage(
        app: FirebaseApp,
        url: String,
        bridgeClient: PyricBridgeClient
    ) -> Storage {
        do {
            return try validatedStorage(app: app, url: url, bridgeClient: bridgeClient)
        } catch {
            preconditionFailure(error.localizedDescription)
        }
    }

    package static func validatedStorage(
        app: FirebaseApp,
        url: String,
        bridgeClient: PyricBridgeClient? = nil
    ) throws -> Storage {
        let parsedBucket = try ParsedStorageLocation.parseBucketURL(url)
        let defaultInfo = resolveDefaultBucket(for: app)
        let isNamed = !parsedBucket.isEmpty && parsedBucket != defaultInfo.bucket
        return cachedOrCreate(
            app: app,
            bucket: parsedBucket,
            isNamedBucket: isNamed,
            configuredDefaultBucket: defaultInfo.wireDefaultBucket,
            bridgeClient: bridgeClient
        )
    }

    /// Evicts all cached `Storage` instances across apps and buckets.
    public static func reset() {
        let evicted: [Storage] = {
            registryLock.lock()
            defer { registryLock.unlock() }
            let all = Array(instances.values)
            instances.removeAll()
            return all
        }()
        for item in evicted {
            item.detachBridgeObserver()
        }
    }

    // MARK: - Configuration Properties

    public var bridgeClient: PyricBridgeClient {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _bridgeClient
    }

    public var maxUploadRetryTime: TimeInterval {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _maxUploadRetryTime
        }
        set {
            stateLock.lock()
            _maxUploadRetryTime = max(0, newValue)
            stateLock.unlock()
        }
    }

    public var maxDownloadRetryTime: TimeInterval {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _maxDownloadRetryTime
        }
        set {
            stateLock.lock()
            _maxDownloadRetryTime = max(0, newValue)
            stateLock.unlock()
        }
    }

    public var maxOperationRetryTime: TimeInterval {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _maxOperationRetryTime
        }
        set {
            stateLock.lock()
            _maxOperationRetryTime = max(0, newValue)
            stateLock.unlock()
        }
    }

    public var uploadChunkSizeBytes: Int64 {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _uploadChunkSizeBytes
        }
        set {
            let normalized: Int64
            if newValue == .max {
                normalized = .max
            } else if newValue < Self.minChunkSizeUnit {
                normalized = Self.minChunkSizeUnit
            } else {
                normalized = (newValue / Self.minChunkSizeUnit) * Self.minChunkSizeUnit
            }
            stateLock.lock()
            _uploadChunkSizeBytes = normalized
            stateLock.unlock()
        }
    }

    public var callbackQueue: DispatchQueue {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _callbackQueue
        }
        set {
            stateLock.lock()
            _callbackQueue = newValue
            stateLock.unlock()
        }
    }

    package func dispatchCallback(_ block: @escaping @Sendable () -> Void) {
        StorageCallbackDispatcher.dispatch(on: callbackQueue, block)
    }

    public var credentialProvider: (any AuthCredentialProvider)? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _credentialProvider
        }
        set {
            stateLock.lock()
            _credentialProvider = newValue
            stateLock.unlock()
        }
    }

    public func switchLens(_ lens: AuthLens?) {
        stateLock.lock()
        _impersonatedLens = lens
        stateLock.unlock()
    }

    package func activeAuthLens() -> AuthLens? {
        let explicit: (impersonated: AuthLens?, provider: (any AuthCredentialProvider)?) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            return (_impersonatedLens, _credentialProvider)
        }()
        if let lens = explicit.impersonated {
            return lens
        }
        if let provider = explicit.provider {
            return provider.currentAuthLens()
        }
        if let registered = AuthCredentialProviderRegistry.resolve(app: app) {
            return registered.currentAuthLens()
        }
        return nil
    }

    package var emulatorConfiguration: (host: String, port: Int)? {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard let host = _emulatorHost, let port = _emulatorPort else {
            return nil
        }
        return (host, port)
    }

    package func markUsed() {
        stateLock.lock()
        _hasUsed = true
        stateLock.unlock()
    }

    // MARK: - Emulator Routing

    /// Configures `Storage` to route operations to a local Pyric host at `host` and `port`.
    public func useEmulator(withHost host: String, port: Int) {
        let cleanHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        precondition(!cleanHost.isEmpty, "Invalid host argument: Cannot connect to empty host.")
        precondition(port >= 0 && port <= 65535, "Invalid port argument: Port must be between 0 and 65535.")

        let alreadySame: Bool = {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _emulatorHost == cleanHost && _emulatorPort == port
        }()
        if alreadySame {
            if usesAppBridge {
                adoptBridgeClient(app.sharedBridgeClient(), host: cleanHost, port: port)
            }
            return
        }

        let alreadyUsed: Bool = {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _hasUsed
        }()
        precondition(
            !alreadyUsed,
            "Cannot connect to emulator after Storage SDK operations have started. Call useEmulator(withHost:port:) before performing operations."
        )

        if usesAppBridge {
            let nextClient = app.useEmulator(withHost: cleanHost, port: port, sslEnabled: false)
            adoptBridgeClient(nextClient, host: cleanHost, port: port)
            Self.propagateAppBridge(
                appName: app.name,
                client: nextClient,
                host: cleanHost,
                port: port,
                excluding: self
            )
        } else {
            let resolved = FirebaseBridgeEndpointResolver.emulatorEndpoint(
                host: cleanHost,
                port: port,
                sslEnabled: false
            )
            let standalone = PyricBridgeClient(
                endpoint: resolved.endpoint,
                headers: ["Host": resolved.hostHeader]
            )
            adoptBridgeClient(standalone, host: cleanHost, port: port)
        }
    }

    // MARK: - Reference Factories

    /// Creates a `StorageReference` initialized at the root of this `Storage` bucket.
    public func reference() -> StorageReference {
        StorageReference(
            storage: self,
            bucket: storageBucket,
            fullPath: "",
            isNamedBucket: isNamedBucket
        )
    }

    /// Creates a `StorageReference` initialized at a relative `path` from the bucket root.
    public func reference(withPath path: String) -> StorageReference {
        reference().child(path)
    }

    /// Creates a `StorageReference` from a `gs://`, `http://`, or `https://` Storage URL string.
    public func reference(forURL url: String) -> StorageReference {
        do {
            return try validatedReference(forURL: url)
        } catch {
            preconditionFailure(error.localizedDescription)
        }
    }

    /// Creates a `StorageReference` from a `gs://`, `http://`, or `https://` `URL`, throwing on mismatch.
    public func reference(for url: URL) throws -> StorageReference {
        try validatedReference(forURL: url.absoluteString)
    }

    package func validatedReference(forURL rawURL: String) throws -> StorageReference {
        let parsed = try ParsedStorageLocation.parseReferenceURL(rawURL)
        if !storageBucket.isEmpty && parsed.bucket != storageBucket {
            throw StorageErrorCode(
                code: .bucketMismatch,
                message: "Provided bucket: `\(parsed.bucket)` does not match the Storage bucket of the current instance: `\(storageBucket)`"
            )
        }
        let effectiveNamed: Bool
        if storageBucket.isEmpty {
            let defaultBucket = configuredDefaultBucket ?? ""
            effectiveNamed = !parsed.bucket.isEmpty && parsed.bucket != defaultBucket && parsed.bucket != "pyric-default"
        } else {
            effectiveNamed = isNamedBucket
        }
        return StorageReference(
            storage: self,
            bucket: parsed.bucket,
            fullPath: parsed.fullPath,
            isNamedBucket: effectiveNamed
        )
    }

    // MARK: - NSObject Overrides

    override public func copy() -> Any {
        let cloned = Storage(
            app: app,
            storageBucket: storageBucket,
            isNamedBucket: isNamedBucket,
            configuredDefaultBucket: configuredDefaultBucket,
            bridgeClient: usesAppBridge ? nil : bridgeClient
        )
        cloned.callbackQueue = callbackQueue
        cloned.maxUploadRetryTime = maxUploadRetryTime
        cloned.maxDownloadRetryTime = maxDownloadRetryTime
        cloned.maxOperationRetryTime = maxOperationRetryTime
        cloned.uploadChunkSizeBytes = uploadChunkSizeBytes
        return cloned
    }

    override public func isEqual(_ object: Any?) -> Bool {
        guard let other = object as? Storage else {
            return false
        }
        return app == other.app && storageBucket == other.storageBucket
    }

    override public var hash: Int {
        var hasher = Hasher()
        hasher.combine(app.name)
        hasher.combine(storageBucket)
        return hasher.finalize()
    }

    // MARK: - Internal Helpers

    private static func resolveDefaultBucket(
        for app: FirebaseApp
    ) -> (bucket: String, wireDefaultBucket: String?) {
        if let rawBucket = app.options.storageBucket {
            let normalized = ParsedStorageLocation.normalizeConfiguredBucket(rawBucket)
            let wireDefault = (!normalized.isEmpty && normalized != "pyric-default") ? normalized : nil
            return (bucket: normalized, wireDefaultBucket: wireDefault)
        }
        if let rawProject = app.options.projectID?.trimmingCharacters(in: .whitespacesAndNewlines),
           !rawProject.isEmpty {
            let derived = "\(rawProject).appspot.com"
            return (bucket: derived, wireDefaultBucket: derived)
        }
        return (bucket: "pyric-default", wireDefaultBucket: nil)
    }

    private static func cachedOrCreate(
        app: FirebaseApp,
        bucket: String,
        isNamedBucket: Bool,
        configuredDefaultBucket: String?,
        bridgeClient: PyricBridgeClient?
    ) -> Storage {
        let key = InstanceKey(appName: app.name, bucket: bucket)
        var evicted: Storage?
        let resolved: Storage = {
            registryLock.lock()
            defer { registryLock.unlock() }
            if let existing = instances[key] {
                let sameApp = existing.app === app
                let sameBridgeMode: Bool
                if let bridgeClient {
                    sameBridgeMode = !existing.usesAppBridge && existing.bridgeClient === bridgeClient
                } else {
                    sameBridgeMode = existing.usesAppBridge
                }
                if sameApp && sameBridgeMode {
                    return existing
                }
                evicted = existing
            }
            let created = Storage(
                app: app,
                storageBucket: bucket,
                isNamedBucket: isNamedBucket,
                configuredDefaultBucket: configuredDefaultBucket,
                bridgeClient: bridgeClient
            )
            instances[key] = created
            return created
        }()
        evicted?.detachBridgeObserver()
        return resolved
    }

    private func adoptObservedAppBridge(_ nextClient: PyricBridgeClient) {
        stateLock.lock()
        if !_hasUsed {
            _bridgeClient = nextClient
        }
        stateLock.unlock()
    }

    private func adoptBridgeClient(_ client: PyricBridgeClient, host: String, port: Int) {
        stateLock.lock()
        _bridgeClient = client
        _emulatorHost = host
        _emulatorPort = port
        stateLock.unlock()
    }

    private static func propagateAppBridge(
        appName: String,
        client: PyricBridgeClient,
        host: String,
        port: Int,
        excluding caller: Storage
    ) {
        let siblings: [Storage] = {
            registryLock.lock()
            defer { registryLock.unlock() }
            return instances.compactMap { key, instance in
                guard key.appName == appName, instance !== caller, instance.usesAppBridge else {
                    return nil
                }
                return instance
            }
        }()
        for sibling in siblings {
            sibling.stateLock.lock()
            if !sibling._hasUsed {
                sibling._bridgeClient = client
                sibling._emulatorHost = host
                sibling._emulatorPort = port
            }
            sibling.stateLock.unlock()
        }
    }

    private func detachBridgeObserver() {
        let observerID: UUID? = {
            stateLock.lock()
            defer { stateLock.unlock() }
            let current = bridgeObserverID
            bridgeObserverID = nil
            return current
        }()
        if let observerID {
            app.removeBridgeObserver(observerID)
        }
    }
}
