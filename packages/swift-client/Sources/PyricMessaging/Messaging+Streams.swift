import Foundation
import PyricFirestore

extension Messaging {
    // MARK: - Foreground & Background Delivery Streams

    /// Asynchronous stream of `RemoteMessagingMessage` payloads delivered while this client's visibility is `.visible`.
    public var foregroundMessages: AsyncStream<RemoteMessagingMessage> {
        AsyncStream { continuation in
            let id = UUID()
            let accepted: Bool = {
                self.stateLock.lock()
                defer { self.stateLock.unlock() }
                guard !self._isDisposed else { return false }
                self.foregroundContinuations[id] = continuation
                return true
            }()
            guard accepted else {
                continuation.finish()
                return
            }
            Task { [weak self] in
                await self?.triggerSubscriptionSync()
            }
            continuation.onTermination = { [weak self] _ in
                self?.removeForegroundContinuation(id: id)
            }
        }
    }

    /// Asynchronous stream of `RemoteMessagingMessage` payloads delivered while this client's visibility is `.hidden`.
    public var backgroundMessages: AsyncStream<RemoteMessagingMessage> {
        AsyncStream { continuation in
            let id = UUID()
            let accepted: Bool = {
                self.stateLock.lock()
                defer { self.stateLock.unlock() }
                guard !self._isDisposed else { return false }
                self.backgroundContinuations[id] = continuation
                return true
            }()
            guard accepted else {
                continuation.finish()
                return
            }
            Task { [weak self] in
                await self?.triggerSubscriptionSync()
            }
            continuation.onTermination = { [weak self] _ in
                self?.removeBackgroundContinuation(id: id)
            }
        }
    }

    /// Registers a foreground delivery callback on `messaging.foreground` and returns a cancellable `MessagingSubscription`.
    @discardableResult
    public func onForegroundMessage(
        _ handler: @escaping @Sendable (RemoteMessagingMessage) -> Void
    ) -> MessagingSubscription {
        let id = UUID()
        stateLock.lock()
        if !_isDisposed {
            foregroundHandlers[id] = handler
        }
        stateLock.unlock()
        Task { [weak self] in
            await self?.triggerSubscriptionSync()
        }
        return MessagingSubscription { [weak self] in
            self?.removeForegroundHandler(id: id)
        }
    }

    /// Registers a background delivery callback on `messaging.background` and returns a cancellable `MessagingSubscription`.
    @discardableResult
    public func onBackgroundMessage(
        _ handler: @escaping @Sendable (RemoteMessagingMessage) async -> Void
    ) -> MessagingSubscription {
        let id = UUID()
        stateLock.lock()
        if !_isDisposed {
            backgroundHandlers[id] = handler
        }
        stateLock.unlock()
        Task { [weak self] in
            await self?.triggerSubscriptionSync()
        }
        return MessagingSubscription { [weak self] in
            self?.removeBackgroundHandler(id: id)
        }
    }

    // MARK: - Package Stream Routing

    package func currentObserverIntent() -> (wantsForeground: Bool, wantsBackground: Bool) {
        stateLock.lock()
        defer { stateLock.unlock() }
        if _isDisposed { return (false, false) }
        let fg = !foregroundContinuations.isEmpty || !foregroundHandlers.isEmpty
        let bg = !backgroundContinuations.isEmpty || !backgroundHandlers.isEmpty
        return (fg, bg)
    }

    package func triggerSubscriptionSync() async {
        let resolved = await resolveEndpointAndHeaders()
        try? await session.syncSubscriptions(endpoint: resolved.endpoint, headers: resolved.headers)
    }

    package func dispatchDeliveredMessage(_ message: RemoteMessagingMessage) {
        switch message.route {
        case .foreground:
            let (conts, handlers): (
                [AsyncStream<RemoteMessagingMessage>.Continuation],
                [@Sendable (RemoteMessagingMessage) -> Void]
            ) = {
                stateLock.lock()
                defer { stateLock.unlock() }
                return (Array(foregroundContinuations.values), Array(foregroundHandlers.values))
            }()
            for cont in conts { cont.yield(message) }
            for handler in handlers { handler(message) }

        case .background, .none:
            let (conts, handlers): (
                [AsyncStream<RemoteMessagingMessage>.Continuation],
                [@Sendable (RemoteMessagingMessage) async -> Void]
            ) = {
                stateLock.lock()
                defer { stateLock.unlock() }
                return (Array(backgroundContinuations.values), Array(backgroundHandlers.values))
            }()
            for cont in conts { cont.yield(message) }
            for handler in handlers {
                Task { await handler(message) }
            }
        }
    }

    package func recordSubscriptionError(_ error: MessagingError) {
        stateLock.lock()
        _lastSubscriptionError = error
        stateLock.unlock()
    }

    private func removeForegroundContinuation(id: UUID) {
        let shouldSync: Bool = {
            stateLock.lock()
            defer { stateLock.unlock() }
            foregroundContinuations.removeValue(forKey: id)
            return !_isDisposed
        }()
        if shouldSync {
            Task { [weak self] in await self?.triggerSubscriptionSync() }
        }
    }

    private func removeBackgroundContinuation(id: UUID) {
        let shouldSync: Bool = {
            stateLock.lock()
            defer { stateLock.unlock() }
            backgroundContinuations.removeValue(forKey: id)
            return !_isDisposed
        }()
        if shouldSync {
            Task { [weak self] in await self?.triggerSubscriptionSync() }
        }
    }

    private func removeForegroundHandler(id: UUID) {
        let shouldSync: Bool = {
            stateLock.lock()
            defer { stateLock.unlock() }
            foregroundHandlers.removeValue(forKey: id)
            return !_isDisposed
        }()
        if shouldSync {
            Task { [weak self] in await self?.triggerSubscriptionSync() }
        }
    }

    private func removeBackgroundHandler(id: UUID) {
        let shouldSync: Bool = {
            stateLock.lock()
            defer { stateLock.unlock() }
            backgroundHandlers.removeValue(forKey: id)
            return !_isDisposed
        }()
        if shouldSync {
            Task { [weak self] in await self?.triggerSubscriptionSync() }
        }
    }
}
