import Foundation
import PyricFirestore
#if canImport(Combine)
import Combine
#endif

/// Main entry point for the Firebase Authentication SDK.
public final class Auth: @unchecked Sendable, AuthCredentialProvider {

    // -- Static Registry --
    private static let registryLock = NSLock()
    nonisolated(unsafe) private static var instances: [String: Auth] = [:]

    public static func auth() -> Auth {
        FirebaseAuthBootstrap.initialize()
        return auth(app: FirebaseApp.app())
    }

    package static func existingInstance(app: FirebaseApp) -> Auth? {
        registryLock.lock()
        defer { registryLock.unlock() }
        guard let existing = instances[app.name], existing.app === app else {
            return nil
        }
        return existing
    }

    public static func auth(app: FirebaseApp) -> Auth {
        FirebaseAuthBootstrap.initialize()
        var evicted: Auth?
        let resolved: Auth = {
            registryLock.lock()
            defer { registryLock.unlock() }
            if let existing = instances[app.name] {
                if existing.app === app {
                    return existing
                }
                evicted = existing
            }
            let created = Auth(app: app)
            instances[app.name] = created
            return created
        }()
        evicted?.detachFromApp()
        return resolved
    }

    public static func reset() {
        let evicted: [Auth] = {
            registryLock.lock()
            defer { registryLock.unlock() }
            let current = Array(instances.values)
            instances.removeAll()
            return current
        }()
        for instance in evicted {
            instance.detachFromApp()
        }
    }

    // -- Properties & State --
    public let app: FirebaseApp
    public var bridgeClient: PyricBridgeClient {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _bridgeClient
    }
    var _bridgeClient: PyricBridgeClient
    private let usesSharedAppBridge: Bool
    var bridgeObserverId: UUID?
    let stateLock = NSLock()
    let transitionLock = NSRecursiveLock()

    var _currentUser: User?
    private var _tenantId: String?
    private var _impersonatedLens: AuthLens?
    var _lastEmittedLens: AuthLens = .anon

    public var currentUser: User? {
        stateLock.lock(); defer { stateLock.unlock() }; return _currentUser
    }

    public var tenantId: String? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _tenantId
        }
        set {
            stateLock.lock()
            _tenantId = newValue
            let currentLens = computeCurrentLensLocked()
            _lastEmittedLens = currentLens
            yieldLensLocked(currentLens)
            stateLock.unlock()
        }
    }

    public var impersonatedLens: AuthLens? {
        stateLock.lock(); defer { stateLock.unlock() }; return _impersonatedLens
    }

    // Listeners & Streams
    struct ListenerRegistrationEntry: Sendable {
        let callback: @Sendable (Auth, User?) -> Void
        let registeredVersion: UInt64
    }

    struct PendingUserTransition: Sendable {
        let version: UInt64
        let uidChanged: Bool
        let user: User?
    }

    var stateListeners: [AuthStateDidChangeListenerHandle: ListenerRegistrationEntry] = [:]
    var idTokenListeners: [AuthStateDidChangeListenerHandle: ListenerRegistrationEntry] = [:]
    var userTransitionVersion: UInt64 = 0
    var pendingUserTransitions: [PendingUserTransition] = []
    var isDrainingUserTransitions = false
    var enrichClaimsForTesting: (@Sendable (User) async -> Void)?

    var authStateContinuations: [UUID: AsyncStream<User?>.Continuation] = [:]
    var idTokenContinuations: [UUID: AsyncStream<User?>.Continuation] = [:]
    private var authLensContinuations: [UUID: AsyncStream<AuthLens>.Continuation] = [:]

    #if canImport(Combine)
    let authStateSubject = CurrentValueSubject<User?, Never>(nil)
    let idTokenSubject = CurrentValueSubject<User?, Never>(nil)
    #endif

    var subTask: Task<Void, Never>?
    var remoteSyncHandles: [OrderedSubscriptionHandle] = []
    var remoteSyncContinuation: AsyncStream<RemoteAuthEvent>.Continuation?
    var remoteLensTask: Task<Void, Never>?

    // -- Initialization --
    public init(app: FirebaseApp, bridgeClient: PyricBridgeClient? = nil) {
        self.app = app
        if let explicitClient = bridgeClient {
            self._bridgeClient = explicitClient
            self.usesSharedAppBridge = false
        } else {
            self._bridgeClient = app.sharedBridgeClient()
            self.usesSharedAppBridge = true
        }
        self._lastEmittedLens = computeCurrentLensLocked()
        if usesSharedAppBridge {
            self.bridgeObserverId = app.addBridgeObserver { [weak self] nextClient in
                self?.applyBridgeClient(nextClient)
            }
        }
        startRemoteLensSync()
        installAuthRestorer()
    }

    deinit {
        if let observerId = bridgeObserverId {
            app.removeBridgeObserver(observerId)
        }
        subTask?.cancel()
        remoteSyncContinuation?.finish()
        for handle in remoteSyncHandles {
            handle.cancel()
        }
        remoteLensTask?.cancel()
    }

    // -- Impersonation & AuthLens (Multi-tenancy Priority) --

    public func switchLens(_ lens: AuthLens?) {
        stateLock.lock()
        _impersonatedLens = lens
        let currentLens = computeCurrentLensLocked()
        _lastEmittedLens = currentLens
        yieldLensLocked(currentLens)
        stateLock.unlock()
    }

    public func currentAuthLens() -> AuthLens {
        stateLock.lock()
        defer { stateLock.unlock() }
        return computeCurrentLensLocked()
    }

    func computeCurrentLensLocked() -> AuthLens {
        if let lens = _impersonatedLens {
            return lens
        }
        if let user = _currentUser {
            return .asUser(uid: user.uid, tenant: user.tenantId, token: user.claims.isEmpty ? nil : user.claims)
        }
        return .anon
    }

    /// Delivers a lens to every lens subscriber. Callers hold `stateLock`, so
    /// two lens changes on different threads reach subscribers in the order
    /// they changed the lens, and each stream's last value is the current lens.
    func yieldLensLocked(_ lens: AuthLens) {
        for cont in authLensContinuations.values {
            cont.yield(lens)
        }
    }

    public var authLensStream: AsyncStream<AuthLens> {
        AsyncStream { continuation in
            let id = UUID()
            stateLock.lock()
            authLensContinuations[id] = continuation
            continuation.yield(computeCurrentLensLocked())
            stateLock.unlock()

            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.stateLock.lock()
                self.authLensContinuations.removeValue(forKey: id)
                self.stateLock.unlock()
            }
        }
    }

    // -- Listeners & Sequences --

    public func addStateDidChangeListener(
        _ listener: @escaping @Sendable (Auth, User?) -> Void
    ) -> AuthStateDidChangeListenerHandle {
        let handle = AuthStateDidChangeListenerHandle()
        transitionLock.lock()
        defer { transitionLock.unlock() }
        stateLock.lock()
        stateListeners[handle] = ListenerRegistrationEntry(
            callback: listener,
            registeredVersion: userTransitionVersion
        )
        let current = _currentUser
        stateLock.unlock()

        listener(self, current)
        return handle
    }

    public func removeStateDidChangeListener(_ handle: AuthStateDidChangeListenerHandle) {
        transitionLock.lock()
        defer { transitionLock.unlock() }
        stateLock.lock()
        stateListeners.removeValue(forKey: handle)
        stateLock.unlock()
    }

    public func addIDTokenDidChangeListener(
        _ listener: @escaping @Sendable (Auth, User?) -> Void
    ) -> AuthStateDidChangeListenerHandle {
        let handle = AuthStateDidChangeListenerHandle()
        transitionLock.lock()
        defer { transitionLock.unlock() }
        stateLock.lock()
        idTokenListeners[handle] = ListenerRegistrationEntry(
            callback: listener,
            registeredVersion: userTransitionVersion
        )
        let current = _currentUser
        stateLock.unlock()

        listener(self, current)
        return handle
    }

    public func removeIDTokenDidChangeListener(_ handle: AuthStateDidChangeListenerHandle) {
        transitionLock.lock()
        defer { transitionLock.unlock() }
        stateLock.lock()
        idTokenListeners.removeValue(forKey: handle)
        stateLock.unlock()
    }

    public var authStateChanges: AuthStateChangesSequence {
        AuthStateChangesSequence(self)
    }

    public var idTokenChanges: IDTokenChangesSequence {
        IDTokenChangesSequence(self)
    }

    // -- Emulation --

    public func useEmulator(withHost host: String, port: Int) {
        if usesSharedAppBridge {
            _ = app.useEmulator(withHost: host, port: port)
            return
        }
        let resolved = FirebaseBridgeEndpointResolver.emulatorEndpoint(
            host: host,
            port: port,
            sslEnabled: false
        )
        let standalone = PyricBridgeClient(
            endpoint: resolved.endpoint,
            headers: ["Host": resolved.hostHeader]
        )
        applyBridgeClient(standalone)
    }

    // -- Operations --

    public func signIn(withEmail email: String, password: String) async throws -> AuthDataResult {
        try await signIn(turn: takeTurn(), withEmail: email, password: password)
    }

    public func signIn(
        withEmail email: String,
        password: String,
        completion: (@Sendable (AuthDataResult?, Error?) -> Void)?
    ) {
        runInCallOrder(completion: completion) { turn in
            try await self.signIn(turn: turn, withEmail: email, password: password)
        }
    }

    private func signIn(turn: OperationTurn, withEmail email: String, password: String) async throws -> AuthDataResult {
        do {
            let res = try await bridgeClient.authSignInEmail(turn: turn, email: email, password: password, tenantId: self.tenantId)
            return try await handleAuthDataResult(res)
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func createUser(withEmail email: String, password: String) async throws -> AuthDataResult {
        try await createUser(turn: takeTurn(), withEmail: email, password: password)
    }

    public func createUser(
        withEmail email: String,
        password: String,
        completion: (@Sendable (AuthDataResult?, Error?) -> Void)?
    ) {
        runInCallOrder(completion: completion) { turn in
            try await self.createUser(turn: turn, withEmail: email, password: password)
        }
    }

    private func createUser(turn: OperationTurn, withEmail email: String, password: String) async throws -> AuthDataResult {
        do {
            let res = try await bridgeClient.authCreateUser(turn: turn, email: email, password: password, tenantId: self.tenantId)
            return try await handleAuthDataResult(res)
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func signInAnonymously() async throws -> AuthDataResult {
        try await signInAnonymously(turn: takeTurn())
    }

    public func signInAnonymously(completion: (@Sendable (AuthDataResult?, Error?) -> Void)?) {
        runInCallOrder(completion: completion) { turn in
            try await self.signInAnonymously(turn: turn)
        }
    }

    private func signInAnonymously(turn: OperationTurn) async throws -> AuthDataResult {
        do {
            let res = try await bridgeClient.authSignInAnonymously(turn: turn, tenantId: self.tenantId)
            return try await handleAuthDataResult(res)
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func signIn(withCustomToken customToken: String) async throws -> AuthDataResult {
        try await signIn(turn: takeTurn(), withCustomToken: customToken)
    }

    public func signIn(
        withCustomToken customToken: String,
        completion: (@Sendable (AuthDataResult?, Error?) -> Void)?
    ) {
        runInCallOrder(completion: completion) { turn in
            try await self.signIn(turn: turn, withCustomToken: customToken)
        }
    }

    private func signIn(turn: OperationTurn, withCustomToken customToken: String) async throws -> AuthDataResult {
        do {
            let res = try await bridgeClient.authSignInWithCustomToken(
                turn: turn,
                customToken: customToken,
                tenantId: self.tenantId
            )
            return try await handleAuthDataResult(res)
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func signIn(with credential: AuthCredential) async throws -> AuthDataResult {
        try await signIn(turn: takeTurn(), with: credential)
    }

    public func signIn(
        with credential: AuthCredential,
        completion: (@Sendable (AuthDataResult?, Error?) -> Void)?
    ) {
        runInCallOrder(completion: completion) { turn in
            try await self.signIn(turn: turn, with: credential)
        }
    }

    private func signIn(turn: OperationTurn, with credential: AuthCredential) async throws -> AuthDataResult {
        do {
            let res = try await bridgeClient.authSignInWithCredential(
                turn: turn,
                params: credential.toWireParams(),
                tenantId: self.tenantId
            )
            return try await handleAuthDataResult(res)
        } catch {
            throw AuthError.from(error: error)
        }
    }

    /// Stages a deterministic federated sign-in result on this Auth instance's
    /// sandbox connection for the next matching `signIn(with:)` credential call.
    public func stageSignInResult(
        providerID: String,
        uid: String,
        email: String? = nil,
        displayName: String? = nil,
        photoURL: URL? = nil,
        isEmailVerified: Bool? = nil,
        customClaims: [String: AnySendable] = [:]
    ) async throws {
        let turn = takeTurn()
        do {
            try await bridgeClient.authMockSignInResult(
                turn: turn,
                providerID: providerID,
                uid: uid,
                email: email,
                displayName: displayName,
                photoURL: photoURL?.absoluteString,
                emailVerified: isEmailVerified,
                customClaims: customClaims
            )
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func signOut() throws {
        stateLock.lock()
        _impersonatedLens = nil
        stateLock.unlock()
        let client = bridgeClient
        let turn = takeTurn()
        Task {
            try? await client.authSignOut(turn: turn)
        }
        applyUserTransition(nil)
    }

    public func restoreSession(uid: String) async throws -> User? {
        let turn = takeTurn()
        do {
            let res = try await bridgeClient.authRestorePortSession(turn: turn, uid: uid, tenantId: self.tenantId)
            if res.isNull {
                applyUserTransition(nil)
                return nil
            }
            if let user = User.fromWire(auth: self, wire: res) {
                await enrichUserClaimsIfLive(user)
                applyUserTransition(user)
                return user
            }
            return nil
        } catch {
            throw AuthError.from(error: error)
        }
    }

    // -- Call Order --

    /// Takes the next place in the order operations reach the bridge. An Auth
    /// or User call takes it where the app makes the call: a completion-block
    /// form before it starts its task, an async form before its first suspension.
    func takeTurn() -> OperationTurn {
        bridgeClient.takeTurn()
    }

    /// Runs a call from a completion-block form in the place of a turn taken
    /// here, before the task starts, then reports its result.
    func runInCallOrder<T: Sendable>(
        completion: (@Sendable (T?, Error?) -> Void)?,
        _ call: @escaping @Sendable (OperationTurn) async throws -> T
    ) {
        let turn = takeTurn()
        Task {
            do {
                let result = try await call(turn)
                completion?(result, nil)
            } catch {
                completion?(nil, error)
            }
        }
    }

    private func handleAuthDataResult(_ wire: AnySendable) async throws -> AuthDataResult {
        guard let dict = wire.dictionaryValue,
              let userWire = dict["user"] else {
            throw AuthError(code: .internalError, message: "Invalid auth credentials reply shape")
        }
        guard let user = User.fromWire(auth: self, wire: userWire) else {
            throw AuthError(code: .internalError, message: "Failed to deserialize authenticated user")
        }
        if user.claims.isEmpty,
           let topClaims = dict["customClaims"]?.dictionaryValue ?? dict["claims"]?.dictionaryValue {
            user.replaceClaims(topClaims)
        }
        await enrichUserClaimsIfLive(user)
        let addInfoDict = dict["additionalUserInfo"]?.dictionaryValue
        let providerId = addInfoDict?["providerId"]?.stringValue ?? dict["providerId"]?.stringValue
        let isNewUser = addInfoDict?["isNewUser"]?.boolValue ?? (dict["operationType"]?.stringValue == "signIn")
        let additional = AdditionalUserInfo(providerID: providerId, isNewUser: isNewUser)
        let result = AuthDataResult(user: user, additionalUserInfo: additional)
        applyUserTransition(user)
        return result
    }

    func currentUserTransitionVersion() -> UInt64 {
        stateLock.lock()
        defer { stateLock.unlock() }
        return userTransitionVersion
    }

    func enrichUserClaimsIfLive(_ user: User) async {
        let testHook: (@Sendable (User) async -> Void)? = {
            stateLock.lock()
            defer { stateLock.unlock() }
            return enrichClaimsForTesting
        }()
        if let testHook {
            await testHook(user)
            return
        }
        let client = bridgeClient
        guard !client.hasInjectedChannel, user.claims["firebase"] == nil else {
            return
        }
        if let tokenWire = try? await client.authGetIdTokenResult(forcingRefresh: false),
           let tokenDict = tokenWire.dictionaryValue {
            let parsed = AuthTokenResult.fromWire(tokenDict)
            if !parsed.claims.isEmpty {
                var merged = user.claims
                for (key, value) in parsed.claims {
                    merged[key] = value
                }
                user.replaceClaims(merged)
            }
        }
    }
}
