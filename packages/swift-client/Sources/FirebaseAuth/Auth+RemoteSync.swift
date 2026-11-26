import Foundation
import PyricFirestore

internal enum RemoteAuthEvent: Sendable {
    case authState(AnySendable)
    case idToken(AnySendable)
}

private final class RemainingSubsCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var remaining: Int

    init(_ count: Int) {
        self.remaining = count
    }

    func decrementAndIsZero() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        remaining -= 1
        return remaining <= 0
    }
}

extension Auth {

    internal func applyBridgeClient(_ nextClient: PyricBridgeClient) {
        let (hadRemoteSync, previousHandles, previousContinuation): (
            Bool,
            [OrderedSubscriptionHandle],
            AsyncStream<RemoteAuthEvent>.Continuation?
        ) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            _bridgeClient = nextClient
            let activeSync = subTask != nil
            subTask?.cancel()
            subTask = nil
            let prev = remoteSyncHandles
            remoteSyncHandles.removeAll()
            let prevCont = remoteSyncContinuation
            remoteSyncContinuation = nil
            remoteLensTask?.cancel()
            remoteLensTask = nil
            return (activeSync, prev, prevCont)
        }()
        previousContinuation?.finish()
        for handle in previousHandles {
            handle.cancel()
        }
        startRemoteLensSync()
        installAuthRestorer()
        if hadRemoteSync {
            startRemoteSync()
        }
    }

    internal func detachFromApp() {
        let (observerId, previousHandles, previousContinuation): (
            UUID?,
            [OrderedSubscriptionHandle],
            AsyncStream<RemoteAuthEvent>.Continuation?
        ) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            let id = bridgeObserverId
            bridgeObserverId = nil
            subTask?.cancel()
            subTask = nil
            let prev = remoteSyncHandles
            remoteSyncHandles.removeAll()
            let prevCont = remoteSyncContinuation
            remoteSyncContinuation = nil
            remoteLensTask?.cancel()
            remoteLensTask = nil
            return (id, prev, prevCont)
        }()
        previousContinuation?.finish()
        for handle in previousHandles {
            handle.cancel()
        }
        if let observerId {
            app.removeBridgeObserver(observerId)
        }
    }

    /// A replaced bridge host holds no user for this session. Install the
    /// restorer synchronously before init or bridge adoption returns (D7, S19).
    internal func installAuthRestorer() {
        let client = bridgeClient
        client.setAuthRestorer { [weak self] op in
            guard let user = self?.currentUser else { return }
            _ = try await op("auth.restorePortSession", [
                "uid": .string(user.uid),
                "tenantId": user.tenantId.map { .string($0) } ?? .null,
            ])
        }
    }

    /// Subscribes to `client.remoteLensStream` synchronously before spawning
    /// the consumer task so an immediate push is never dropped (D7, S13).
    internal func startRemoteLensSync() {
        let client = bridgeClient
        let stream = client.remoteLensStream
        let task = Task { [weak self] in
            for await remoteLens in stream {
                guard !Task.isCancelled else { break }
                guard let self else { break }
                self.switchLens(remoteLens)
            }
        }
        stateLock.lock()
        let previous = remoteLensTask
        remoteLensTask = task
        stateLock.unlock()
        previous?.cancel()
    }

    private func applyRemoteUserWire(_ userWire: AnySendable) async {
        guard !Task.isCancelled,
              let wireDict = userWire.dictionaryValue,
              let incomingUid = wireDict["uid"]?.stringValue else {
            return
        }
        if let existing = currentUser, existing.uid == incomingUid {
            existing.update(from: wireDict)
            applyUserTransition(existing)
            return
        }
        let versionBeforeEnrich = currentUserTransitionVersion()
        if let user = User.fromWire(auth: self, wire: userWire) {
            await enrichUserClaimsIfLive(user)
            guard !Task.isCancelled else { return }
            applyUserTransition(user, expectedVersion: versionBeforeEnrich)
        }
    }

    /// Opens `authState` and `idToken` subscriptions synchronously before
    /// returning so both reserve their admission turns ahead of subsequent ops
    /// (D7, S18) and drains both through one serial stream in socket frame
    /// arrival order (D8, S21).
    public func startRemoteSync() {
        stateLock.lock()
        guard subTask == nil else {
            stateLock.unlock()
            return
        }
        let client = _bridgeClient
        let (mergedStream, mergedContinuation) = AsyncStream<RemoteAuthEvent>.makeStream()
        let remaining = RemainingSubsCounter(2)
        let onSubFinish: @Sendable (Error?) -> Void = { _ in
            if remaining.decrementAndIsZero() {
                mergedContinuation.finish()
            }
        }
        let authHandle = client.openOrderedSubscription(
            target: .string("authState"),
            onEvent: { event in
                if case .value(let payload) = event {
                    mergedContinuation.yield(.authState(payload))
                }
            },
            onFinish: onSubFinish
        )
        let idTokenHandle = client.openOrderedSubscription(
            target: .string("idToken"),
            onEvent: { event in
                if case .value(let payload) = event {
                    mergedContinuation.yield(.idToken(payload))
                }
            },
            onFinish: onSubFinish
        )
        remoteSyncHandles = [authHandle, idTokenHandle]
        remoteSyncContinuation = mergedContinuation

        let task = Task { [weak self] in
            for await remoteEvent in mergedStream {
                guard !Task.isCancelled, let self else { break }
                switch remoteEvent {
                case .authState(let event):
                    let userWire = event["user"] ?? event
                    if event.isNull || userWire.isNull {
                        self.applyUserTransition(nil)
                    } else {
                        await self.applyRemoteUserWire(userWire)
                    }
                case .idToken(let event):
                    let userWire = event["user"] ?? event
                    if event.isNull || userWire.isNull {
                        self.applyUserTransition(nil)
                    } else if userWire.dictionaryValue?["uid"]?.stringValue != nil {
                        await self.applyRemoteUserWire(userWire)
                    } else {
                        self.notifyIdTokenChanged()
                    }
                }
            }
        }
        subTask = task
        stateLock.unlock()
    }
}
