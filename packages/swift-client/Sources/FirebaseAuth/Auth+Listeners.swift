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
            let current = _currentUser
            stateLock.unlock()

            continuation.yield(current)

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
            let current = _currentUser
            stateLock.unlock()

            continuation.yield(current)

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

    internal func applyUserTransition(_ newUser: User?) {
        stateLock.lock()
        let previousUid = _currentUser?.uid
        let newUid = newUser?.uid
        _currentUser = newUser

        let currentLens = computeCurrentLensLocked()
        let lensChanged = (_lastEmittedLens != currentLens)
        if lensChanged {
            _lastEmittedLens = currentLens
            yieldLensLocked(currentLens)
        }

        let stateCallbacks = Array(stateListeners.values)
        let tokenCallbacks = Array(idTokenListeners.values)
        let stateConts = Array(authStateContinuations.values)
        let tokenConts = Array(idTokenContinuations.values)
        stateLock.unlock()

        #if canImport(Combine)
        if previousUid != newUid {
            authStateSubject.send(newUser)
        }
        idTokenSubject.send(newUser)
        #endif

        if previousUid != newUid {
            for callback in stateCallbacks {
                callback(self, newUser)
            }
            for cont in stateConts {
                cont.yield(newUser)
            }
        }

        for callback in tokenCallbacks {
            callback(self, newUser)
        }
        for cont in tokenConts {
            cont.yield(newUser)
        }
    }

    internal func notifyIdTokenChanged(user: User? = nil) {
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
            if currentUser?.uid == user.uid {
                applyUserTransition(nil)
            }
        default:
            break
        }
    }
}
