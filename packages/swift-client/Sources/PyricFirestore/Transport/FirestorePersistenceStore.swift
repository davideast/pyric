import Foundation

internal final class FirestorePersistenceStore: @unchecked Sendable {
    static let shared = FirestorePersistenceStore()

    private struct StoreKey: Hashable {
        let appName: String
        let database: String
        let authScope: String
    }

    private struct DatabaseCache {
        var docs: [String: CachedDocumentRecord] = [:]
        var namedQueries: [String: BundledNamedQuerySpec] = [:]
        var hasCachedQueryResults: Bool = false
    }

    private let lock = NSLock()
    private var caches: [StoreKey: DatabaseCache] = [:]

    func docsSnapshot(appName: String, database: String, authScope: String) -> [String: CachedDocumentRecord] {
        lock.lock()
        defer { lock.unlock() }
        return caches[StoreKey(appName: appName, database: database, authScope: authScope)]?.docs ?? [:]
    }

    func recordDoc(
        appName: String,
        database: String,
        authScope: String,
        path: String,
        exists: Bool,
        encodedFields: [String: AnySendable]?
    ) {
        lock.lock()
        let key = StoreKey(appName: appName, database: database, authScope: authScope)
        var entry = caches[key] ?? DatabaseCache()
        entry.docs[path] = CachedDocumentRecord(exists: exists, encodedFields: exists ? (encodedFields ?? [:]) : nil)
        caches[key] = entry
        lock.unlock()
    }

    func removeDoc(appName: String, database: String, authScope: String, path: String) {
        lock.lock()
        let key = StoreKey(appName: appName, database: database, authScope: authScope)
        var entry = caches[key] ?? DatabaseCache()
        entry.docs.removeValue(forKey: path)
        caches[key] = entry
        lock.unlock()
    }

    func markQueryWarmed(appName: String, database: String, authScope: String) {
        lock.lock()
        let key = StoreKey(appName: appName, database: database, authScope: authScope)
        var entry = caches[key] ?? DatabaseCache()
        entry.hasCachedQueryResults = true
        caches[key] = entry
        lock.unlock()
    }

    func recordNamedQuery(appName: String, database: String, authScope: String, spec: BundledNamedQuerySpec) {
        lock.lock()
        let key = StoreKey(appName: appName, database: database, authScope: authScope)
        var entry = caches[key] ?? DatabaseCache()
        entry.namedQueries[spec.name] = spec
        entry.hasCachedQueryResults = true
        caches[key] = entry
        lock.unlock()
    }

    func namedQuery(appName: String, database: String, authScope: String, name: String) -> BundledNamedQuerySpec? {
        lock.lock()
        defer { lock.unlock() }
        return caches[StoreKey(appName: appName, database: database, authScope: authScope)]?.namedQueries[name]
    }

    func clear(appName: String, database: String) {
        lock.lock()
        caches = caches.filter { !($0.key.appName == appName && $0.key.database == database) }
        lock.unlock()
    }

    func resetAll() {
        lock.lock()
        caches.removeAll()
        lock.unlock()
    }
}

internal struct StagedOfflineWriteEntry: Sendable {
    let stageId: Int
    let writeId: UUID
    let method: String
    let params: [String: AnySendable]
    let actAs: AuthLens
    let mutations: [OfflineWriteMutation]
    let continuation: CheckedContinuation<Void, Error>
}

internal final class PendingWriteSettlement: @unchecked Sendable {
    private let lock = NSLock()
    private var settled = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if settled {
                lock.unlock()
                continuation.resume()
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    func markSettled() {
        lock.lock()
        guard !settled else {
            lock.unlock()
            return
        }
        settled = true
        let pending = waiters
        waiters.removeAll()
        lock.unlock()
        for waiter in pending {
            waiter.resume()
        }
    }
}

internal struct ManagedSnapshotListenerHooks: Sendable {
    let target: TargetDescriptor
    let includeMetadataChanges: Bool
    let cacheOnly: Bool
    let hasDeliveredOnline: @Sendable () -> Bool
    let hasDeliveredAny: @Sendable () -> Bool
    let suspendFromHost: @Sendable () -> Void
    let resumeOnHost: @Sendable () -> Void
    let deliverOfflineProjection: @Sendable () -> Void
    let cancelFromTerminate: @Sendable () -> Void
}
