import Foundation

public protocol LocalCacheSettings: Sendable {}

public struct MemoryCacheSettings: LocalCacheSettings, Sendable, Equatable {
    public init() {}
}

public struct PersistentCacheSettings: LocalCacheSettings, Sendable, Equatable {
    public let sizeBytes: Int64
    public init(sizeBytes: Int64 = 100 * 1024 * 1024) {
        self.sizeBytes = sizeBytes
    }
}

public final class FirestoreSettings: @unchecked Sendable {
    public var host: String
    public var sslEnabled: Bool
    public var isSSLEnabled: Bool {
        get { sslEnabled }
        set { sslEnabled = newValue }
    }
    public var dispatchQueue: DispatchQueue
    public var cacheSettings: any LocalCacheSettings

    public init() {
        self.host = "127.0.0.1:5174"
        self.sslEnabled = false
        self.dispatchQueue = .main
        self.cacheSettings = MemoryCacheSettings()
    }

    public init(
        host: String = "127.0.0.1:5174",
        sslEnabled: Bool = false,
        dispatchQueue: DispatchQueue = .main,
        cacheSettings: any LocalCacheSettings = MemoryCacheSettings()
    ) {
        self.host = host
        self.sslEnabled = sslEnabled
        self.dispatchQueue = dispatchQueue
        self.cacheSettings = cacheSettings
    }

    private static let fallbackQueue = DispatchQueue(label: "dev.pyric.firestore.callback-fallback")

    public func dispatchCallback(_ block: @escaping @Sendable () -> Void) {
        #if os(macOS)
        if dispatchQueue === DispatchQueue.main {
            Self.fallbackQueue.async(execute: block)
            return
        }
        #endif
        dispatchQueue.async(execute: block)
    }
}

public enum FirestoreSource: Int, Sendable {
    case `default` = 0
    case server = 1
    case cache = 2
}

public struct SnapshotListenOptions: Sendable {
    public var includeMetadataChanges: Bool
    public init(includeMetadataChanges: Bool = false) {
        self.includeMetadataChanges = includeMetadataChanges
    }
}
