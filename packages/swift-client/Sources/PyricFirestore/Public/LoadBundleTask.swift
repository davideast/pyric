import Foundation

public typealias LoadBundleObserverHandle = Int

public enum LoadBundleTaskState: Int, Sendable, Equatable {
    case error = 0
    case inProgress = 1
    case success = 2
}

public final class LoadBundleTaskProgress: Sendable, Equatable {
    public let documentsLoaded: Int
    public let totalDocuments: Int
    public let bytesLoaded: Int
    public let totalBytes: Int
    public let state: LoadBundleTaskState

    public init(
        documentsLoaded: Int,
        totalDocuments: Int,
        bytesLoaded: Int,
        totalBytes: Int,
        state: LoadBundleTaskState
    ) {
        self.documentsLoaded = documentsLoaded
        self.totalDocuments = totalDocuments
        self.bytesLoaded = bytesLoaded
        self.totalBytes = totalBytes
        self.state = state
    }

    public static func == (lhs: LoadBundleTaskProgress, rhs: LoadBundleTaskProgress) -> Bool {
        lhs.documentsLoaded == rhs.documentsLoaded
            && lhs.totalDocuments == rhs.totalDocuments
            && lhs.bytesLoaded == rhs.bytesLoaded
            && lhs.totalBytes == rhs.totalBytes
            && lhs.state == rhs.state
    }
}

public final class LoadBundleTask: @unchecked Sendable {
    private final class ObserverEntry: @unchecked Sendable {
        var isRemoved: Bool = false
        let callback: @Sendable (LoadBundleTaskProgress) -> Void

        init(_ callback: @escaping @Sendable (LoadBundleTaskProgress) -> Void) {
            self.callback = callback
        }
    }

    private let lock = NSLock()
    private let dispatchCallback: @Sendable (@escaping @Sendable () -> Void) -> Void
    private var nextHandle: LoadBundleObserverHandle = 1
    private var observers: [LoadBundleObserverHandle: ObserverEntry] = [:]
    private var history: [LoadBundleTaskProgress] = []
    private var terminalResult: Result<LoadBundleTaskProgress, Error>?
    private var waiters: [CheckedContinuation<LoadBundleTaskProgress, Error>] = []

    internal init(
        dispatchCallback: @escaping @Sendable (@escaping @Sendable () -> Void) -> Void,
        completion: (@Sendable (LoadBundleTaskProgress?, Error?) -> Void)? = nil,
        executor: @escaping @Sendable (
            @escaping @Sendable (LoadBundleTaskProgress) -> Void
        ) async throws -> LoadBundleTaskProgress
    ) {
        self.dispatchCallback = dispatchCallback
        Task { [self] in
            do {
                let finalProgress = try await executor { [weak self] step in
                    self?.recordProgress(step)
                }
                self.finish(with: .success(finalProgress), completion: completion)
            } catch {
                self.finishWithError(error, completion: completion)
            }
        }
    }

    @discardableResult
    public func addObserver(
        _ observer: @escaping @Sendable (LoadBundleTaskProgress) -> Void
    ) -> LoadBundleObserverHandle {
        let entry = ObserverEntry(observer)
        lock.lock()
        let handle = nextHandle
        nextHandle += 1
        let replaySteps = history
        let isTerminal = terminalResult != nil
        if !isTerminal {
            observers[handle] = entry
        }
        lock.unlock()

        for step in replaySteps {
            dispatchCallback {
                guard !entry.isRemoved else { return }
                entry.callback(step)
            }
        }
        return handle
    }

    public func removeObserverWithHandle(_ handle: LoadBundleObserverHandle) {
        lock.lock()
        let removed = observers.removeValue(forKey: handle)
        removed?.isRemoved = true
        lock.unlock()
    }

    public func removeAllObservers() {
        lock.lock()
        let entries = Array(observers.values)
        observers.removeAll()
        for entry in entries {
            entry.isRemoved = true
        }
        lock.unlock()
    }

    internal func value() async throws -> LoadBundleTaskProgress {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let terminalResult {
                lock.unlock()
                continuation.resume(with: terminalResult)
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    private func recordProgress(_ progress: LoadBundleTaskProgress) {
        lock.lock()
        guard terminalResult == nil else {
            lock.unlock()
            return
        }
        history.append(progress)
        let activeEntries = Array(observers.values)
        lock.unlock()

        for entry in activeEntries {
            dispatchCallback {
                guard !entry.isRemoved else { return }
                entry.callback(progress)
            }
        }
    }

    private func finish(
        with result: Result<LoadBundleTaskProgress, Error>,
        completion: (@Sendable (LoadBundleTaskProgress?, Error?) -> Void)?
    ) {
        lock.lock()
        guard terminalResult == nil else {
            lock.unlock()
            return
        }
        if case .success(let finalProgress) = result {
            let needsAppend = history.last != finalProgress
            if needsAppend {
                history.append(finalProgress)
            }
            terminalResult = result
            let activeEntries = needsAppend ? Array(observers.values) : []
            observers.removeAll()
            let pendingWaiters = waiters
            waiters.removeAll()
            lock.unlock()

            for entry in activeEntries {
                dispatchCallback {
                    guard !entry.isRemoved else { return }
                    entry.callback(finalProgress)
                }
            }
            if let completion {
                dispatchCallback {
                    completion(finalProgress, nil)
                }
            }
            for waiter in pendingWaiters {
                waiter.resume(returning: finalProgress)
            }
            return
        }
        lock.unlock()
    }

    private func finishWithError(
        _ error: Error,
        completion: (@Sendable (LoadBundleTaskProgress?, Error?) -> Void)?
    ) {
        lock.lock()
        guard terminalResult == nil else {
            lock.unlock()
            return
        }
        let last = history.last
        let errorProgress = LoadBundleTaskProgress(
            documentsLoaded: last?.documentsLoaded ?? 0,
            totalDocuments: last?.totalDocuments ?? 0,
            bytesLoaded: last?.bytesLoaded ?? 0,
            totalBytes: last?.totalBytes ?? 0,
            state: .error
        )
        history.append(errorProgress)
        terminalResult = .failure(error)
        let activeEntries = Array(observers.values)
        observers.removeAll()
        let pendingWaiters = waiters
        waiters.removeAll()
        lock.unlock()

        for entry in activeEntries {
            dispatchCallback {
                guard !entry.isRemoved else { return }
                entry.callback(errorProgress)
            }
        }
        if let completion {
            dispatchCallback {
                completion(nil, error)
            }
        }
        for waiter in pendingWaiters {
            waiter.resume(throwing: error)
        }
    }
}

extension Firestore {
    @_disfavoredOverload
    @discardableResult
    public func loadBundle(_ bundleData: Data) -> LoadBundleTask {
        loadBundle(bundleData, completion: nil)
    }

    @discardableResult
    public func loadBundle(
        _ bundleData: Data,
        completion: (@Sendable (LoadBundleTaskProgress?, Error?) -> Void)?
    ) -> LoadBundleTask {
        startBundleLoadTask(completion: completion) {
            bundleData
        }
    }

    @discardableResult
    public func loadBundle(_ bundleData: Data) async throws -> LoadBundleTaskProgress {
        let task = loadBundle(bundleData, completion: nil)
        return try await task.value()
    }

    @_disfavoredOverload
    @discardableResult
    public func loadBundle(_ bundleStream: InputStream) -> LoadBundleTask {
        loadBundle(bundleStream, completion: nil)
    }

    @discardableResult
    public func loadBundle(
        _ bundleStream: InputStream,
        completion: (@Sendable (LoadBundleTaskProgress?, Error?) -> Void)?
    ) -> LoadBundleTask {
        let streamBox = UncheckedStreamBox(bundleStream)
        return startBundleLoadTask(completion: completion) {
            try BundleWireDecoder.readStream(streamBox.stream)
        }
    }

    @discardableResult
    public func loadBundle(_ bundleStream: InputStream) async throws -> LoadBundleTaskProgress {
        let task = loadBundle(bundleStream, completion: nil)
        return try await task.value()
    }

    public func getQuery(
        named name: String,
        completion: @escaping @Sendable (Query?) -> Void
    ) {
        hasUsed = true
        let currentSettings = settings
        let pendingLoads = lifecycle.snapshotActiveBundleLoads()
        if pendingLoads.isEmpty {
            let resolved = resolveBundledNamedQuery(named: name)
            currentSettings.dispatchCallback {
                completion(resolved)
            }
            return
        }
        Task { [weak self] in
            for load in pendingLoads {
                await load.wait()
            }
            let resolved = self?.resolveBundledNamedQuery(named: name)
            currentSettings.dispatchCallback {
                completion(resolved)
            }
        }
    }

    public func getQuery(named name: String) async -> Query? {
        await withCheckedContinuation { continuation in
            getQuery(named: name) { query in
                continuation.resume(returning: query)
            }
        }
    }

    private func resolveBundledNamedQuery(named name: String) -> Query? {
        guard !lifecycle.isTerminated else {
            return nil
        }
        lifecycle.markStarted()
        guard let spec = lifecycle.bundledNamedQuery(named: name) else {
            return nil
        }
        if spec.isCollectionGroup {
            return Query(
                firestore: self,
                rootSource: .group(collectionId: spec.collectionPath),
                path: "",
                constraints: spec.constraints
            )
        }
        return Query(
            firestore: self,
            rootSource: .collection(path: spec.collectionPath),
            path: spec.collectionPath,
            constraints: spec.constraints
        )
    }

    private func startBundleLoadTask(
        completion: (@Sendable (LoadBundleTaskProgress?, Error?) -> Void)?,
        readBytes: @escaping @Sendable () throws -> Data
    ) -> LoadBundleTask {
        hasUsed = true
        let currentSettings = settings
        let bundleLoadId = lifecycle.beginBundleLoad()
        return LoadBundleTask(
            dispatchCallback: { block in currentSettings.dispatchCallback(block) },
            completion: completion
        ) { [weak self] emit in
            defer {
                self?.lifecycle.finishBundleLoad(bundleLoadId)
            }
            guard let self else {
                throw PyricBridgeError(code: .aborted, message: "Firestore instance was deallocated.")
            }
            try self.lifecycle.ensureActiveAndMarkStarted()
            let rawBytes = try readBytes()
            let decoded = try BundleWireDecoder.decode(rawBytes)
            emit(
                LoadBundleTaskProgress(
                    documentsLoaded: 0,
                    totalDocuments: decoded.totalDocuments,
                    bytesLoaded: 0,
                    totalBytes: decoded.totalBytes,
                    state: .inProgress
                )
            )
            for namedSpec in decoded.namedQueries {
                self.lifecycle.recordBundledNamedQuery(namedSpec)
            }
            for (idx, docEntry) in decoded.documents.enumerated() {
                self.lifecycle.recordBundledEntry(docEntry)
                emit(
                    LoadBundleTaskProgress(
                        documentsLoaded: idx + 1,
                        totalDocuments: decoded.totalDocuments,
                        bytesLoaded: docEntry.bytesLoadedAfterDoc,
                        totalBytes: decoded.totalBytes,
                        state: .inProgress
                    )
                )
            }
            let finalProgress = LoadBundleTaskProgress(
                documentsLoaded: decoded.totalDocuments,
                totalDocuments: decoded.totalDocuments,
                bytesLoaded: decoded.totalBytes,
                totalBytes: decoded.totalBytes,
                state: .success
            )
            emit(finalProgress)
            return finalProgress
        }
    }
}

private final class UncheckedStreamBox: @unchecked Sendable {
    let stream: InputStream
    init(_ stream: InputStream) {
        self.stream = stream
    }
}
