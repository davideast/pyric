import Foundation
import PyricFirestore

extension Auth {

    internal func applyBridgeClient(_ nextClient: PyricBridgeClient) {
        let (hadRemoteSync, previousIterators): (Bool, [PyricSubscriptionStream.Iterator]) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            _bridgeClient = nextClient
            let activeSync = subTask != nil
            subTask?.cancel()
            subTask = nil
            let prev = remoteSyncIterators
            remoteSyncIterators.removeAll()
            remoteLensTask?.cancel()
            remoteLensTask = nil
            return (activeSync, prev)
        }()
        for iterator in previousIterators {
            iterator.cancel()
        }
        startRemoteLensSync()
        installAuthRestorer()
        if hadRemoteSync {
            startRemoteSync()
        }
    }

    internal func detachFromApp() {
        let (observerId, previousIterators): (UUID?, [PyricSubscriptionStream.Iterator]) = {
            stateLock.lock()
            defer { stateLock.unlock() }
            let id = bridgeObserverId
            bridgeObserverId = nil
            subTask?.cancel()
            subTask = nil
            let prev = remoteSyncIterators
            remoteSyncIterators.removeAll()
            remoteLensTask?.cancel()
            remoteLensTask = nil
            return (id, prev)
        }()
        for iterator in previousIterators {
            iterator.cancel()
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
        guard let wireDict = userWire.dictionaryValue,
              let incomingUid = wireDict["uid"]?.stringValue else {
            return
        }
        if let existing = currentUser, existing.uid == incomingUid {
            existing.update(from: wireDict)
            applyUserTransition(existing)
            return
        }
        if let user = User.fromWire(auth: self, wire: userWire) {
            await enrichUserClaimsIfLive(user)
            applyUserTransition(user)
        }
    }

    /// Opens `authState` and `idToken` subscriptions synchronously before
    /// returning so both reserve their admission turns ahead of subsequent ops
    /// (D7, S18).
    public func startRemoteSync() {
        stateLock.lock()
        guard subTask == nil else {
            stateLock.unlock()
            return
        }
        let client = _bridgeClient
        let authIterator = client.subscribe(target: .string("authState")).makeAsyncIterator()
        let idTokenIterator = client.subscribe(target: .string("idToken")).makeAsyncIterator()
        remoteSyncIterators = [authIterator, idTokenIterator]

        let task = Task { [weak self] in
            guard let self else { return }
            await withTaskGroup(of: Void.self) { group in
                group.addTask { [weak self] in
                    guard let self else { return }
                    do {
                        while let event = try await authIterator.next() {
                            guard !Task.isCancelled else { break }
                            let userWire = event["user"] ?? event
                            if event.isNull || userWire.isNull {
                                self.applyUserTransition(nil)
                            } else {
                                await self.applyRemoteUserWire(userWire)
                            }
                        }
                    } catch {
                        // Subscription terminated or bridge disconnected
                    }
                }
                group.addTask { [weak self] in
                    guard let self else { return }
                    do {
                        while let event = try await idTokenIterator.next() {
                            guard !Task.isCancelled else { break }
                            let userWire = event["user"] ?? event
                            if event.isNull || userWire.isNull {
                                self.applyUserTransition(nil)
                            } else if userWire.dictionaryValue?["uid"]?.stringValue != nil {
                                await self.applyRemoteUserWire(userWire)
                            } else {
                                self.notifyIdTokenChanged()
                            }
                        }
                    } catch {
                        // Subscription terminated or bridge disconnected
                    }
                }
            }
        }
        subTask = task
        stateLock.unlock()
    }
}
