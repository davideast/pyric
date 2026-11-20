import Foundation

/// Coordinates subscription lifecycle against active security rules evaluation lenses
/// and Firestore client network state (`disableNetwork` / `enableNetwork` / `terminate`).
/// Automatically tears down and re-subscribes active bridge subscriptions upon auth transitions.
/// A dropped connection does not end the subscription: the bridge client re-sends it on
/// re-attach and reports the gap through `onGap`.
internal final class SnapshotSubscriptionCoordinator: @unchecked Sendable {
    private let firestore: Firestore
    private let target: TargetDescriptor
    private let includeMetadataChanges: Bool
    private let listenSource: String?
    private let onEvent: @Sendable (AnySendable) -> Void
    private let onOffline: @Sendable () -> Void
    private let onGap: @Sendable () -> Void
    private let onError: @Sendable (Error) -> Void

    private var coordinatorTask: Task<Void, Never>?
    private var activeChildTask: Task<Void, Never>?
    private var lifecycleToken: UUID?
    private let lock = NSLock()
    private var isCancelled = false
    private var deliveredAny = false
    private var deliveredOnline = false
    private var currentLens: AuthLens = .anon

    init(
        firestore: Firestore,
        target: TargetDescriptor,
        includeMetadataChanges: Bool,
        listenSource: String? = nil,
        onEvent: @escaping @Sendable (AnySendable) -> Void,
        onOffline: @escaping @Sendable () -> Void = {},
        onGap: @escaping @Sendable () -> Void = {},
        onError: @escaping @Sendable (Error) -> Void
    ) {
        self.firestore = firestore
        self.target = target
        self.includeMetadataChanges = includeMetadataChanges
        self.listenSource = listenSource
        self.onEvent = onEvent
        self.onOffline = onOffline
        self.onGap = onGap
        self.onError = onError

        if firestore.lifecycle.isTerminated {
            isCancelled = true
            let err = PyricBridgeError(code: .failedPrecondition, message: "The client has already been terminated.")
            onError(err)
            return
        }

        currentLens = firestore.effectiveAuthLens
        let token = firestore.lifecycle.registerManagedListener(
            ManagedSnapshotListenerHooks(
                target: target,
                includeMetadataChanges: includeMetadataChanges,
                cacheOnly: listenSource == "cache",
                hasDeliveredOnline: { [weak self] in
                    self?.withLock { self?.deliveredOnline ?? false } ?? false
                },
                hasDeliveredAny: { [weak self] in
                    self?.withLock { self?.deliveredAny ?? false } ?? false
                },
                suspendFromHost: { [weak self] in
                    self?.suspendForOffline()
                },
                resumeOnHost: { [weak self] in
                    self?.resumeForOnline()
                },
                deliverOfflineProjection: { [weak self] in
                    self?.deliverOffline()
                },
                cancelFromTerminate: { [weak self] in
                    self?.cancelInternal(unregisterFromLifecycle: false)
                }
            )
        )
        self.lifecycleToken = token
        start()
    }

    var cancelled: Bool {
        withLock { isCancelled }
    }

    private func withLock<T>(_ block: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return block()
    }

    private func start() {
        if listenSource == "cache" {
            deliverOffline()
            return
        }
        if !firestore.lifecycle.isNetworkEnabled {
            deliverOffline()
        }
        coordinatorTask = Task { [weak self] in
            guard let self else { return }
            var lastLens: AuthLens? = nil

            for await lens in self.firestore.authLensStream {
                guard !Task.isCancelled else { break }
                let action = self.withLock { () -> Bool in
                    if self.isCancelled { return false }
                    self.currentLens = lens
                    if let last = lastLens, last == lens { return false }
                    lastLens = lens
                    return true
                }
                if action && self.firestore.lifecycle.isNetworkEnabled {
                    self.reconnect(with: lens)
                }
            }
        }
    }

    private func suspendForOffline() {
        withLock {
            activeChildTask?.cancel()
            activeChildTask = nil
        }
    }

    private func resumeForOnline() {
        if listenSource == "cache" {
            return
        }
        let lensAndActive: AuthLens? = withLock {
            guard !isCancelled else { return nil }
            return currentLens
        }
        if let lens = lensAndActive, firestore.lifecycle.isNetworkEnabled {
            reconnect(with: lens)
        }
    }

    private func deliverOffline() {
        let shouldDeliver = withLock { () -> Bool in
            guard !isCancelled else { return false }
            deliveredAny = true
            deliveredOnline = false
            return true
        }
        if shouldDeliver {
            onOffline()
        }
    }

    private func reconnect(with lens: AuthLens) {
        withLock {
            activeChildTask?.cancel()
            activeChildTask = nil
            guard !isCancelled, firestore.lifecycle.isNetworkEnabled else { return }

            let client = firestore.bridgeClient
            let target = self.target
            let includeMeta = self.includeMetadataChanges
            let listenSource = self.listenSource
            let onEvent = self.onEvent
            let onGap = self.onGap
            let onError = self.onError

            activeChildTask = Task { [weak self] in
                let stream = client.subscribe(
                    target: target,
                    actAs: lens,
                    includeMetadataChanges: includeMeta,
                    listenSource: listenSource
                ).events
                do {
                    for try await event in stream {
                        guard !Task.isCancelled, let self else { break }
                        let active = self.withLock { () -> Bool in
                            guard !self.isCancelled, self.firestore.lifecycle.isNetworkEnabled else { return false }
                            self.deliveredAny = true
                            switch event {
                            case .value:
                                self.deliveredOnline = true
                            case .gap:
                                self.deliveredOnline = false
                            }
                            return true
                        }
                        guard active else { break }
                        switch event {
                        case .value(let value):
                            onEvent(value)
                        case .gap:
                            onGap()
                        }
                    }
                } catch {
                    guard !Task.isCancelled, let self else { return }
                    let shouldReport = self.withLock { !self.isCancelled && self.firestore.lifecycle.isNetworkEnabled }
                    if shouldReport {
                        onError(error)
                    }
                }
            }
        }
    }

    func cancel() {
        cancelInternal(unregisterFromLifecycle: true)
    }

    private func cancelInternal(unregisterFromLifecycle: Bool) {
        let tokenToRemove: UUID? = withLock {
            isCancelled = true
            coordinatorTask?.cancel()
            coordinatorTask = nil
            activeChildTask?.cancel()
            activeChildTask = nil
            let token = lifecycleToken
            lifecycleToken = nil
            return token
        }
        if unregisterFromLifecycle, let tokenToRemove {
            firestore.lifecycle.unregisterManagedListener(tokenToRemove)
        }
    }
}
