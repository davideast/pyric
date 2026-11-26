import Foundation
#if canImport(Combine)
import Combine
#endif

extension Auth {

    // -- Modern Concurrency Streams --

    public var authStateDidChangeStream: AsyncStream<User?> {
        AsyncStream { continuation in
            let id = UUID()
            stateLock.lock()
            authStateContinuations[id] = continuation
            continuation.yield(_currentUser)
            stateLock.unlock()

            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.stateLock.lock()
                self.authStateContinuations.removeValue(forKey: id)
                self.stateLock.unlock()
            }
        }
    }

    public var idTokenDidChangeStream: AsyncStream<User?> {
        AsyncStream { continuation in
            let id = UUID()
            stateLock.lock()
            idTokenContinuations[id] = continuation
            continuation.yield(_currentUser)
            stateLock.unlock()

            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.stateLock.lock()
                self.idTokenContinuations.removeValue(forKey: id)
                self.stateLock.unlock()
            }
        }
    }

    #if canImport(Combine)
    public var authStatePublisher: AnyPublisher<User?, Never> {
        authStateSubject.eraseToAnyPublisher()
    }

    public var idTokenPublisher: AnyPublisher<User?, Never> {
        idTokenSubject.eraseToAnyPublisher()
    }
    #endif

    // -- Internal State Fan-Out --

    private func isStateListenerActive(_ handle: AuthStateDidChangeListenerHandle) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return stateListeners[handle] != nil
    }

    private func isIDTokenListenerActive(_ handle: AuthStateDidChangeListenerHandle) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return idTokenListeners[handle] != nil
    }

    internal func applyUserTransition(_ newUser: User?, expectedVersion: UInt64? = nil) {
        transitionLock.lock()
        defer { transitionLock.unlock() }

        stateLock.lock()
        if let expectedVersion, userTransitionVersion != expectedVersion {
            stateLock.unlock()
            return
        }
        userTransitionVersion &+= 1
        let version = userTransitionVersion
        let previousUid = _currentUser?.uid
        let newUid = newUser?.uid
        let uidChanged = (previousUid != newUid)
        _currentUser = newUser

        let currentLens = computeCurrentLensLocked()
        let lensChanged = (_lastEmittedLens != currentLens)
        if lensChanged {
            _lastEmittedLens = currentLens
            yieldLensLocked(currentLens)
        }

        if uidChanged {
            for cont in authStateContinuations.values {
                cont.yield(newUser)
            }
        }
        for cont in idTokenContinuations.values {
            cont.yield(newUser)
        }

        pendingUserTransitions.append(
            PendingUserTransition(version: version, uidChanged: uidChanged, user: newUser)
        )
        if isDrainingUserTransitions {
            stateLock.unlock()
            return
        }
        isDrainingUserTransitions = true
        stateLock.unlock()

        while true {
            stateLock.lock()
            if pendingUserTransitions.isEmpty {
                isDrainingUserTransitions = false
                stateLock.unlock()
                return
            }
            let item = pendingUserTransitions.removeFirst()
            let stateEntries = Array(stateListeners)
            let tokenEntries = Array(idTokenListeners)
            stateLock.unlock()

            #if canImport(Combine)
            if item.uidChanged {
                authStateSubject.send(item.user)
            }
            idTokenSubject.send(item.user)
            #endif

            if item.uidChanged {
                for (handle, entry) in stateEntries {
                    guard entry.registeredVersion < item.version,
                          isStateListenerActive(handle) else {
                        continue
                    }
                    entry.callback(self, item.user)
                }
            }

            for (handle, entry) in tokenEntries {
                guard entry.registeredVersion < item.version,
                      isIDTokenListenerActive(handle) else {
                    continue
                }
                entry.callback(self, item.user)
            }
        }
    }

    internal func notifyIdTokenChanged(user: User? = nil) {
        transitionLock.lock()
        defer { transitionLock.unlock() }
        stateLock.lock()
        let targetUser = user ?? _currentUser
        stateLock.unlock()
        applyUserTransition(targetUser)
    }

    internal func refreshAuthLensIfNeeded() {
        stateLock.lock()
        let currentLens = computeCurrentLensLocked()
        if _lastEmittedLens != currentLens {
            _lastEmittedLens = currentLens
            yieldLensLocked(currentLens)
        }
        stateLock.unlock()
    }

    internal func notifyUserUpdated(_ user: User) {
        applyUserTransition(user)
    }

    internal func handleSessionInvalidationIfNeeded(for user: User, error: AuthError) {
        switch error.code {
        case .userDisabled, .userTokenExpired, .userNotFound:
            transitionLock.lock()
            defer { transitionLock.unlock() }
            if currentUser?.uid == user.uid {
                applyUserTransition(nil)
            }
        default:
            break
        }
    }
}
