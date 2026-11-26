import Foundation

/// One event on a bridge subscription.
public enum BridgeSubscriptionEvent: Sendable, Equatable {
    /// A value the bridge delivered for the subscription.
    case value(AnySendable)
    /// The connection dropped after this subscription delivered a value. Sent
    /// only to subscriptions opened with `includeMetadataChanges`.
    case gap
}

/// An asynchronous sequence of snapshots emitted by a bridge subscription.
/// Automatically unregisters and sends a worker-unsub frame when iteration terminates or is cancelled.
/// The subscription survives a dropped connection: the client re-sends it on every re-attach.
public struct PyricSubscriptionStream: AsyncSequence, Sendable {
    public typealias Element = AnySendable
    public typealias Failure = Error

    public let client: PyricBridgeClient
    public let target: AnySendable
    public let actAs: AnySendable?
    public let includeMetadataChanges: Bool
    public let listenSource: String?

    public init(
        client: PyricBridgeClient,
        target: AnySendable,
        actAs: AnySendable? = nil,
        includeMetadataChanges: Bool = false,
        listenSource: String? = nil
    ) {
        self.client = client
        self.target = target
        self.actAs = actAs
        self.includeMetadataChanges = includeMetadataChanges
        self.listenSource = listenSource
    }

    /// The same subscription with connection gaps reported in-band.
    public var events: PyricSubscriptionEventStream {
        PyricSubscriptionEventStream(
            client: client,
            target: target,
            actAs: actAs,
            includeMetadataChanges: includeMetadataChanges,
            listenSource: listenSource
        )
    }

    public func makeAsyncIterator() -> Iterator {
        Iterator(inner: events.makeAsyncIterator())
    }

    /// Yields delivered values and skips gap events.
    public final class Iterator: AsyncIteratorProtocol, @unchecked Sendable {
        public typealias Element = AnySendable

        private let inner: PyricSubscriptionEventStream.Iterator

        init(inner: PyricSubscriptionEventStream.Iterator) {
            self.inner = inner
        }

        public func next() async throws -> AnySendable? {
            while let event = try await inner.next() {
                if case .value(let value) = event { return value }
            }
            return nil
        }

        package func cancel() {
            inner.cancel()
        }
    }
}

/// A bridge subscription whose elements include connection gaps.
public struct PyricSubscriptionEventStream: AsyncSequence, Sendable {
    public typealias Element = BridgeSubscriptionEvent
    public typealias Failure = Error

    public let client: PyricBridgeClient
    public let target: AnySendable
    public let actAs: AnySendable?
    public let includeMetadataChanges: Bool
    public let listenSource: String?

    public init(
        client: PyricBridgeClient,
        target: AnySendable,
        actAs: AnySendable? = nil,
        includeMetadataChanges: Bool = false,
        listenSource: String? = nil
    ) {
        self.client = client
        self.target = target
        self.actAs = actAs
        self.includeMetadataChanges = includeMetadataChanges
        self.listenSource = listenSource
    }

    public func makeAsyncIterator() -> Iterator {
        Iterator(
            client: client,
            target: target,
            actAs: actAs,
            includeMetadataChanges: includeMetadataChanges,
            listenSource: listenSource
        )
    }

    /// Thread-safe iterator managing subscription lifecycle and asynchronous cancellation.
    public final class Iterator: AsyncIteratorProtocol, @unchecked Sendable {
        public typealias Element = BridgeSubscriptionEvent

        private let client: PyricBridgeClient
        private let lock = NSLock()
        private var subId: String?
        private var isCleanedUp: Bool = false
        private var streamIterator: AsyncThrowingStream<BridgeSubscriptionEvent, Error>.Iterator?
        private var registrationTask: Task<Void, Never>?

        init(
            client: PyricBridgeClient,
            target: AnySendable,
            actAs: AnySendable?,
            includeMetadataChanges: Bool,
            listenSource: String?
        ) {
            self.client = client
            let (stream, continuation) = AsyncThrowingStream<BridgeSubscriptionEvent, Error>.makeStream()
            self.streamIterator = stream.makeAsyncIterator()

            if let opened = client.openSubscription(
                target: target,
                actAs: actAs,
                includeMetadataChanges: includeMetadataChanges,
                listenSource: listenSource,
                continuation: continuation
            ) {
                self.subId = opened.subId
                self.registrationTask = opened.task
            }
        }

        package func cancel() {
            cleanup()
        }

        public func next() async throws -> BridgeSubscriptionEvent? {
            guard !Task.isCancelled else {
                cleanup()
                throw CancellationError()
            }
            guard var iterator = streamIterator else {
                cleanup()
                return nil
            }
            do {
                let nextElement = try await iterator.next()
                self.streamIterator = iterator
                if nextElement == nil {
                    cleanup()
                }
                return nextElement
            } catch {
                cleanup()
                throw error
            }
        }

        private func cleanup() {
            lock.lock()
            if isCleanedUp {
                lock.unlock()
                return
            }
            isCleanedUp = true
            let idToUnregister = self.subId
            self.subId = nil
            lock.unlock()

            if let idToUnregister {
                if !client.cancelPendingSubscription(subId: idToUnregister) {
                    Task { [client] in
                        await client.unregisterSubscription(subId: idToUnregister)
                    }
                }
            }
        }

        deinit {
            cleanup()
        }
    }
}
