import Foundation
import PyricFirestore
#if canImport(Combine)
import Combine
#endif

/// Main entry point for the Firebase Authentication SDK.
public final class Auth: @unchecked Sendable, AuthCredentialProvider {

    // ── Static Registry ──────────────────────────────────────────────────────
    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var instances: [String: Auth] = [:]

    public static func auth() -> Auth {
        FirebaseAuthBootstrap.initialize()
        return auth(app: FirebaseApp.app())
    }

    public static func auth(app: FirebaseApp) -> Auth {
        FirebaseAuthBootstrap.initialize()
        registryLock.lock()
        defer { registryLock.unlock() }
        if let existing = instances[app.name] {
            return existing
        }
        let created = Auth(app: app)
        instances[app.name] = created
        return created
    }

    public static func reset() {
        registryLock.lock()
        defer { registryLock.unlock() }
        instances.removeAll()
    }

    // ── Properties & State ───────────────────────────────────────────────────
    public let app: FirebaseApp
    public private(set) var bridgeClient: PyricBridgeClient
    private let stateLock = NSLock()

    private var _currentUser: User?
    private var _impersonatedLens: AuthLens?
    private var _lastEmittedLens: AuthLens = .anon

    public var currentUser: User? {
        stateLock.lock(); defer { stateLock.unlock() }; return _currentUser
    }

    public var impersonatedLens: AuthLens? {
        stateLock.lock(); defer { stateLock.unlock() }; return _impersonatedLens
    }

    // Listeners & Streams
    private var stateListeners: [AuthStateDidChangeListenerHandle: @Sendable (Auth, User?) -> Void] = [:]
    private var idTokenListeners: [AuthStateDidChangeListenerHandle: @Sendable (Auth, User?) -> Void] = [:]

    private var authStateContinuations: [UUID: AsyncStream<User?>.Continuation] = [:]
    private var idTokenContinuations: [UUID: AsyncStream<User?>.Continuation] = [:]
    private var authLensContinuations: [UUID: AsyncStream<AuthLens>.Continuation] = [:]

    #if canImport(Combine)
    private let authStateSubject = CurrentValueSubject<User?, Never>(nil)
    private let idTokenSubject = CurrentValueSubject<User?, Never>(nil)
    #endif

    private var subTask: Task<Void, Never>?
    private var remoteLensTask: Task<Void, Never>?

    // ── Initialization ───────────────────────────────────────────────────────
    public init(app: FirebaseApp, bridgeClient: PyricBridgeClient? = nil) {
        self.app = app
        self.bridgeClient = bridgeClient ?? Firestore.firestore(app: app).bridgeClient
        self._lastEmittedLens = computeCurrentLensLocked()
        startRemoteLensSync()
    }

    deinit {
        subTask?.cancel()
        remoteLensTask?.cancel()
    }

    private func startRemoteLensSync() {
        remoteLensTask?.cancel()
        let client = bridgeClient
        remoteLensTask = Task { [weak self] in
            for await remoteLens in client.remoteLensStream {
                guard !Task.isCancelled else { break }
                guard let self else { break }
                self.switchLens(remoteLens)
            }
        }
    }

    // ── Impersonation & AuthLens (Multi-tenancy Priority) ─────────────────────

    public func switchLens(_ lens: AuthLens?) {
        stateLock.lock()
        _impersonatedLens = lens
        let currentLens = computeCurrentLensLocked()
        _lastEmittedLens = currentLens
        let lensConts = Array(authLensContinuations.values)
        stateLock.unlock()

        for cont in lensConts {
            cont.yield(currentLens)
        }
    }

    public func currentAuthLens() -> AuthLens {
        stateLock.lock()
        defer { stateLock.unlock() }
        return computeCurrentLensLocked()
    }

    private func computeCurrentLensLocked() -> AuthLens {
        if let lens = _impersonatedLens {
            return lens
        }
        if let user = _currentUser {
            return .asUser(uid: user.uid, tenant: user.tenant, token: user.claims.isEmpty ? nil : user.claims)
        }
        return .anon
    }

    public var authLensStream: AsyncStream<AuthLens> {
        AsyncStream { continuation in
            let id = UUID()
            stateLock.lock()
            authLensContinuations[id] = continuation
            let initial = computeCurrentLensLocked()
            stateLock.unlock()

            continuation.yield(initial)

            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.stateLock.lock()
                self.authLensContinuations.removeValue(forKey: id)
                self.stateLock.unlock()
            }
        }
    }

    // ── Emulation ────────────────────────────────────────────────────────────

    public func useEmulator(withHost host: String, port: Int) {
        let endpoint = URL(string: "ws://\(host):\(port)/__pyric/sandbox")!
        stateLock.lock()
        subTask?.cancel()
        remoteLensTask?.cancel()
        self.bridgeClient = PyricBridgeClient(endpoint: endpoint, headers: ["Host": "\(host):\(port)"])
        stateLock.unlock()
        startRemoteLensSync()
        startRemoteSync()
    }

    // ── Operations ───────────────────────────────────────────────────────────

    public func signIn(withEmail email: String, password: String) async throws -> AuthDataResult {
        do {
            let res = try await bridgeClient.authSignInEmail(email: email, password: password)
            return try handleAuthDataResult(res)
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func signIn(
        withEmail email: String,
        password: String,
        completion: (@Sendable (AuthDataResult?, Error?) -> Void)?
    ) {
        Task {
            do {
                let res = try await self.signIn(withEmail: email, password: password)
                completion?(res, nil)
            } catch {
                completion?(nil, error)
            }
        }
    }

    public func createUser(withEmail email: String, password: String) async throws -> AuthDataResult {
        do {
            let res = try await bridgeClient.authCreateUser(email: email, password: password)
            return try handleAuthDataResult(res)
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func createUser(
        withEmail email: String,
        password: String,
        completion: (@Sendable (AuthDataResult?, Error?) -> Void)?
    ) {
        Task {
            do {
                let res = try await self.createUser(withEmail: email, password: password)
                completion?(res, nil)
            } catch {
                completion?(nil, error)
            }
        }
    }

    public func signInAnonymously() async throws -> AuthDataResult {
        do {
            let res = try await bridgeClient.authSignInAnonymously()
            return try handleAuthDataResult(res)
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func signInAnonymously(completion: (@Sendable (AuthDataResult?, Error?) -> Void)?) {
        Task {
            do {
                let res = try await self.signInAnonymously()
                completion?(res, nil)
            } catch {
                completion?(nil, error)
            }
        }
    }

    public func signOut() throws {
        stateLock.lock()
        _impersonatedLens = nil
        stateLock.unlock()
        Task {
            try? await bridgeClient.authSignOut()
        }
        applyUserTransition(nil)
    }

    public func restoreSession(uid: String) async throws -> User? {
        do {
            let res = try await bridgeClient.authRestorePortSession(uid: uid)
            if res.isNull {
                applyUserTransition(nil)
                return nil
            }
            if let user = User.fromWire(auth: self, wire: res) {
                applyUserTransition(user)
                return user
            }
            return nil
        } catch {
            throw AuthError.from(error: error)
        }
    }

    private func handleAuthDataResult(_ wire: AnySendable) throws -> AuthDataResult {
        guard let dict = wire.dictionaryValue,
              let userWire = dict["user"] else {
            throw AuthError(code: .internalError, message: "Invalid auth credentials reply shape")
        }
        guard let user = User.fromWire(auth: self, wire: userWire) else {
            throw AuthError(code: .internalError, message: "Failed to deserialize authenticated user")
        }
        let providerId = dict["providerId"]?.stringValue
        let isNewUser = dict["operationType"]?.stringValue == "signIn"
        let additional = AdditionalUserInfo(providerID: providerId, isNewUser: isNewUser)
        let result = AuthDataResult(user: user, additionalUserInfo: additional)
        applyUserTransition(user)
        return result
    }

    // ── Listeners & Modern Concurrency Streams ────────────────────────────────

    public func addStateDidChangeListener(
        _ listener: @escaping @Sendable (Auth, User?) -> Void
    ) -> AuthStateDidChangeListenerHandle {
        let handle = AuthStateDidChangeListenerHandle()
        stateLock.lock()
        stateListeners[handle] = listener
        let current = _currentUser
        stateLock.unlock()

        listener(self, current)
        return handle
    }

    public func removeStateDidChangeListener(_ handle: AuthStateDidChangeListenerHandle) {
        stateLock.lock()
        defer { stateLock.unlock() }
        stateListeners.removeValue(forKey: handle)
    }

    public func addIDTokenDidChangeListener(
        _ listener: @escaping @Sendable (Auth, User?) -> Void
    ) -> AuthStateDidChangeListenerHandle {
        let handle = AuthStateDidChangeListenerHandle()
        stateLock.lock()
        idTokenListeners[handle] = listener
        let current = _currentUser
        stateLock.unlock()

        listener(self, current)
        return handle
    }

    public func removeIDTokenDidChangeListener(_ handle: AuthStateDidChangeListenerHandle) {
        stateLock.lock()
        defer { stateLock.unlock() }
        idTokenListeners.removeValue(forKey: handle)
    }

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

    public var authStateChanges: AuthStateChangesSequence {
        AuthStateChangesSequence(self)
    }

    public var idTokenChanges: IDTokenChangesSequence {
        IDTokenChangesSequence(self)
    }

    #if canImport(Combine)
    public var authStatePublisher: AnyPublisher<User?, Never> {
        authStateSubject.eraseToAnyPublisher()
    }

    public var idTokenPublisher: AnyPublisher<User?, Never> {
        idTokenSubject.eraseToAnyPublisher()
    }
    #endif

    // ── Internal State Fan-Out ───────────────────────────────────────────────

    internal func applyUserTransition(_ newUser: User?) {
        stateLock.lock()
        let previousUid = _currentUser?.uid
        let newUid = newUser?.uid
        _currentUser = newUser

        let currentLens = computeCurrentLensLocked()
        let lensChanged = (_lastEmittedLens != currentLens)
        if lensChanged {
            _lastEmittedLens = currentLens
        }

        let stateCallbacks = Array(stateListeners.values)
        let tokenCallbacks = Array(idTokenListeners.values)
        let stateConts = Array(authStateContinuations.values)
        let tokenConts = Array(idTokenContinuations.values)
        let lensConts = Array(authLensContinuations.values)
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

        if lensChanged {
            for cont in lensConts {
                cont.yield(currentLens)
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

    internal func notifyUserUpdated(_ user: User) {
        applyUserTransition(user)
    }

    public func startRemoteSync() {
        stateLock.lock()
        guard subTask == nil else {
            stateLock.unlock()
            return
        }
        let task = Task { [weak self] in
            guard let self else { return }
            await withTaskGroup(of: Void.self) { group in
                group.addTask { [weak self] in
                    guard let self else { return }
                    let authSubStream = self.bridgeClient.subscribe(target: .string("authState"))
                    do {
                        for try await event in authSubStream {
                            guard !Task.isCancelled else { break }
                            if event.isNull {
                                self.applyUserTransition(nil)
                            } else if let user = User.fromWire(auth: self, wire: event) {
                                self.applyUserTransition(user)
                            }
                        }
                    } catch {
                        // Subscription terminated or bridge disconnected
                    }
                }
                group.addTask { [weak self] in
                    guard let self else { return }
                    let idTokenSubStream = self.bridgeClient.subscribe(target: .string("idToken"))
                    do {
                        for try await event in idTokenSubStream {
                            guard !Task.isCancelled else { break }
                            if !event.isNull, let userDict = event["user"] {
                                if let user = User.fromWire(auth: self, wire: userDict) {
                                    self.applyUserTransition(user)
                                }
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
