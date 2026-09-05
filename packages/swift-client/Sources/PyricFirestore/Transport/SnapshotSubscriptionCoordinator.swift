import Foundation

/// Coordinates subscription lifecycle against active security rules evaluation lenses.
/// Automatically tears down and re-subscribes active bridge subscriptions upon auth transitions.
internal final class SnapshotSubscriptionCoordinator: @unchecked Sendable {
    private let firestore: Firestore
    private let target: TargetDescriptor
    private let includeMetadataChanges: Bool
    private let listenSource: String?
    private let onEvent: @Sendable (AnySendable) -> Void
    private let onError: @Sendable (Error) -> Void

    private var coordinatorTask: Task<Void, Never>?
    private var activeChildTask: Task<Void, Never>?
    private let lock = NSLock()
    private var isCancelled = false

    init(
        firestore: Firestore,
        target: TargetDescriptor,
        includeMetadataChanges: Bool,
        listenSource: String? = nil,
        onEvent: @escaping @Sendable (AnySendable) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) {
        self.firestore = firestore
        self.target = target
        self.includeMetadataChanges = includeMetadataChanges
        self.listenSource = listenSource
        self.onEvent = onEvent
        self.onError = onError
        start()
    }

    private func withLock<T>(_ block: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return block()
    }

    private func start() {
        coordinatorTask = Task { [weak self] in
            guard let self else { return }
            var lastLens: AuthLens? = nil

            for await lens in self.firestore.authLensStream {
                guard !Task.isCancelled else { break }
                let shouldReconnect = self.withLock { () -> Bool in
                    if self.isCancelled { return false }
                    if let last = lastLens, last == lens { return false }
                    lastLens = lens
                    return true
                }
                if shouldReconnect {
                    self.reconnect(with: lens)
                }
            }
        }
    }

    private func reconnect(with lens: AuthLens) {
        withLock {
            activeChildTask?.cancel()
            guard !isCancelled else { return }

            let client = firestore.bridgeClient
            let target = self.target
            let includeMeta = self.includeMetadataChanges
            let listenSource = self.listenSource
            let onEvent = self.onEvent
            let onError = self.onError

            activeChildTask = Task {
                let stream = client.subscribe(
                    target: target,
                    actAs: lens,
                    includeMetadataChanges: includeMeta,
                    listenSource: listenSource
                )
                do {
                    for try await event in stream {
                        guard !Task.isCancelled else { break }
                        onEvent(event)
                    }
                } catch {
                    guard !Task.isCancelled else { return }
                    onError(error)
                }
            }
        }
    }

    func cancel() {
        withLock {
            isCancelled = true
            coordinatorTask?.cancel()
            coordinatorTask = nil
            activeChildTask?.cancel()
            activeChildTask = nil
        }
    }
}
