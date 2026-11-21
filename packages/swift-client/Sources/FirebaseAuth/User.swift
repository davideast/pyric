import Foundation
import PyricFirestore

/// Represents an authenticated user identity within Firebase Authentication.
public final class User: @unchecked Sendable, UserInfo {
    /// Upstream firebase-ios-sdk top-level User.providerID constant (kFirebaseAuthProviderID).
    public static let firebaseProviderID = "Firebase"

    internal weak var auth: Auth?
    private let lock = NSLock()

    public let uid: String
    private var _email: String?
    private var _displayName: String?
    private var _photoURL: URL?
    private var _phoneNumber: String?
    private var _isAnonymous: Bool
    private var _isEmailVerified: Bool
    private var _providerID: String
    private var _providerData: [UserInfoImpl]
    private var _tenant: String?
    private var _claims: [String: AnySendable]
    private var _metadata: UserMetadata

    public var email: String? {
        lock.lock(); defer { lock.unlock() }; return _email
    }
    public var displayName: String? {
        lock.lock(); defer { lock.unlock() }; return _displayName
    }
    public var photoURL: URL? {
        lock.lock(); defer { lock.unlock() }; return _photoURL
    }
    public var phoneNumber: String? {
        lock.lock(); defer { lock.unlock() }; return _phoneNumber
    }
    public var isAnonymous: Bool {
        lock.lock(); defer { lock.unlock() }; return _isAnonymous
    }
    public var isEmailVerified: Bool {
        lock.lock(); defer { lock.unlock() }; return _isEmailVerified
    }
    public var providerID: String {
        lock.lock(); defer { lock.unlock() }; return _providerID
    }
    public var providerData: [UserInfo] {
        lock.lock(); defer { lock.unlock() }; return _providerData
    }
    public var tenant: String? {
        lock.lock(); defer { lock.unlock() }; return _tenant
    }
    public var tenantId: String? {
        lock.lock(); defer { lock.unlock() }; return _tenant
    }
    public var tenantID: String? {
        lock.lock(); defer { lock.unlock() }; return _tenant
    }
    public var claims: [String: AnySendable] {
        lock.lock(); defer { lock.unlock() }; return _claims
    }
    public var customClaims: [String: AnySendable] {
        claims
    }
    public var metadata: UserMetadata {
        lock.lock(); defer { lock.unlock() }; return _metadata
    }

    public init(
        auth: Auth? = nil,
        uid: String,
        email: String? = nil,
        displayName: String? = nil,
        photoURL: URL? = nil,
        phoneNumber: String? = nil,
        isAnonymous: Bool = false,
        isEmailVerified: Bool = false,
        providerID: String = User.firebaseProviderID,
        providerData: [UserInfoImpl] = [],
        tenant: String? = nil,
        claims: [String: AnySendable] = [:],
        metadata: UserMetadata = UserMetadata()
    ) {
        self.auth = auth
        self.uid = uid
        self._email = email
        self._displayName = displayName
        self._photoURL = photoURL
        self._phoneNumber = phoneNumber
        self._isAnonymous = isAnonymous
        self._isEmailVerified = isEmailVerified
        self._providerID = Self.normalizeTopLevelProviderID(providerID)
        self._providerData = providerData
        self._tenant = tenant
        self._claims = claims
        self._metadata = metadata
    }

    private static func normalizeTopLevelProviderID(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else {
            return firebaseProviderID
        }
        if raw == "firebase" {
            return firebaseProviderID
        }
        return raw
    }

    // -- ID Tokens --

    public func getIDToken(forcingRefresh: Bool = false) async throws -> String {
        let auth = try attachedAuth()
        return try await getIDToken(auth, turn: auth.takeTurn(), forcingRefresh: forcingRefresh)
    }

    public func getIDToken(
        forcingRefresh: Bool = false,
        completion: @escaping @Sendable (String?, Error?) -> Void
    ) {
        inCallOrder(completion: completion) { auth, turn in
            try await self.getIDToken(auth, turn: turn, forcingRefresh: forcingRefresh)
        }
    }

    public func getIDTokenForcingRefresh(_ forceRefresh: Bool) async throws -> String {
        try await getIDToken(forcingRefresh: forceRefresh)
    }

    public func getIDTokenForcingRefresh(
        _ forceRefresh: Bool,
        completion: (@Sendable (String?, Error?) -> Void)?
    ) {
        inCallOrder(completion: completion) { auth, turn in
            try await self.getIDToken(auth, turn: turn, forcingRefresh: forceRefresh)
        }
    }

    private func getIDToken(_ auth: Auth, turn: OperationTurn, forcingRefresh: Bool) async throws -> String {
        do {
            let token = try await auth.bridgeClient.authGetIdToken(turn: turn, forcingRefresh: forcingRefresh)
            if forcingRefresh {
                auth.notifyIdTokenChanged(user: self)
            }
            return token
        } catch {
            let authError = AuthError.from(error: error)
            auth.handleSessionInvalidationIfNeeded(for: self, error: authError)
            throw authError
        }
    }

    public func getIDTokenResult(forcingRefresh: Bool = false) async throws -> AuthTokenResult {
        let auth = try attachedAuth()
        return try await getIDTokenResult(auth, turn: auth.takeTurn(), forcingRefresh: forcingRefresh)
    }

    public func getIDTokenResult(
        forcingRefresh: Bool = false,
        completion: @escaping @Sendable (AuthTokenResult?, Error?) -> Void
    ) {
        inCallOrder(completion: completion) { auth, turn in
            try await self.getIDTokenResult(auth, turn: turn, forcingRefresh: forcingRefresh)
        }
    }

    private func getIDTokenResult(_ auth: Auth, turn: OperationTurn, forcingRefresh: Bool) async throws -> AuthTokenResult {
        do {
            let wire = try await auth.bridgeClient.authGetIdTokenResult(turn: turn, forcingRefresh: forcingRefresh)
            guard let dict = wire.dictionaryValue else {
                throw AuthError(code: .internalError, message: "Malformed getIdTokenResult response")
            }
            let res = AuthTokenResult.fromWire(dict)
            self.setClaims(res.claims)
            if forcingRefresh {
                auth.notifyIdTokenChanged(user: self)
            } else {
                auth.refreshAuthLensIfNeeded()
            }
            return res
        } catch {
            let authError = AuthError.from(error: error)
            auth.handleSessionInvalidationIfNeeded(for: self, error: authError)
            throw authError
        }
    }

    // -- Profile & Account Lifecycle Mutations --

    public func createProfileChangeRequest() -> UserProfileChangeRequest {
        UserProfileChangeRequest(user: self)
    }

    public func updateProfile(displayName: String?, photoURL: URL?) async throws {
        let auth = try attachedAuth()
        try await updateProfile(auth, turn: auth.takeTurn(), displayName: displayName, photoURL: photoURL)
    }

    public func updateProfile(
        displayName: String?,
        photoURL: URL?,
        completion: (@Sendable (Error?) -> Void)?
    ) {
        inVoidCallOrder(completion: completion) { auth, turn in
            try await self.updateProfile(auth, turn: turn, displayName: displayName, photoURL: photoURL)
        }
    }

    private func updateProfile(
        _ auth: Auth,
        turn: OperationTurn,
        displayName: String?,
        photoURL: URL?
    ) async throws {
        do {
            let reply = try await auth.bridgeClient.authUpdateProfile(
                turn: turn,
                displayName: displayName,
                photoURL: photoURL?.absoluteString
            )
            if let dict = reply.dictionaryValue {
                self.update(from: dict)
                auth.notifyUserUpdated(self)
            }
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func reload() async throws {
        let auth = try attachedAuth()
        try await reload(auth, turn: auth.takeTurn())
    }

    public func reload(completion: (@Sendable (Error?) -> Void)?) {
        inVoidCallOrder(completion: completion) { auth, turn in
            try await self.reload(auth, turn: turn)
        }
    }

    private func reload(_ auth: Auth, turn: OperationTurn) async throws {
        do {
            let reply = try await auth.bridgeClient.authReload(turn: turn, uid: self.uid)
            if let dict = reply.dictionaryValue {
                self.update(from: dict)
                auth.notifyUserUpdated(self)
            }
        } catch {
            let authError = AuthError.from(error: error)
            auth.handleSessionInvalidationIfNeeded(for: self, error: authError)
            throw authError
        }
    }

    public func delete() async throws {
        let auth = try attachedAuth()
        let turn = auth.takeTurn()
        do {
            try await auth.bridgeClient.authDeleteUser(turn: turn)
            if auth.currentUser?.uid == self.uid {
                auth.applyUserTransition(nil)
            }
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func delete(completion: (@Sendable (Error?) -> Void)?) {
        inVoidCallOrder(completion: completion) { auth, turn in
            do {
                try await auth.bridgeClient.authDeleteUser(turn: turn)
                if auth.currentUser?.uid == self.uid {
                    auth.applyUserTransition(nil)
                }
            } catch {
                throw AuthError.from(error: error)
            }
        }
    }

    public func updatePassword(to password: String) async throws {
        let auth = try attachedAuth()
        let turn = auth.takeTurn()
        do {
            let reply = try await auth.bridgeClient.authUpdatePassword(turn: turn, password: password)
            if let dict = reply.dictionaryValue {
                self.update(from: dict)
                auth.notifyUserUpdated(self)
            }
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func link(with credential: AuthCredential) async throws -> AuthDataResult {
        let auth = try attachedAuth()
        let turn = auth.takeTurn()
        do {
            let reply = try await auth.bridgeClient.authLinkWithCredential(
                turn: turn,
                uid: self.uid,
                tenantId: self.tenantID,
                credentialParams: credential.toWireParams()
            )
            return try await auth.decodeUserCredentialWire(reply, existingUser: self)
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func reauthenticate(with credential: AuthCredential) async throws -> AuthDataResult {
        let auth = try attachedAuth()
        let turn = auth.takeTurn()
        do {
            let reply = try await auth.bridgeClient.authReauthenticateWithCredential(
                turn: turn,
                uid: self.uid,
                tenantId: self.tenantID,
                credentialParams: credential.toWireParams()
            )
            return try await auth.decodeUserCredentialWire(reply, existingUser: self)
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func unlink(fromProvider providerID: String) async throws -> User {
        let auth = try attachedAuth()
        let turn = auth.takeTurn()
        do {
            let reply = try await auth.bridgeClient.authUnlink(
                turn: turn,
                uid: self.uid,
                tenantId: self.tenantID,
                providerID: providerID
            )
            if let dict = reply.dictionaryValue {
                self.update(from: dict)
                auth.notifyUserUpdated(self)
            }
            return self
        } catch {
            throw AuthError.from(error: error)
        }
    }

    // -- Call Order --

    private func attachedAuth() throws -> Auth {
        guard let auth = self.auth else {
            throw AuthError(code: .noCurrentUser, message: "User is not attached to an active Auth instance.")
        }
        return auth
    }

    private func inCallOrder<T: Sendable>(
        completion: (@Sendable (T?, Error?) -> Void)?,
        _ call: @escaping @Sendable (Auth, OperationTurn) async throws -> T
    ) {
        let auth: Auth
        do {
            auth = try attachedAuth()
        } catch {
            Task { completion?(nil, error) }
            return
        }
        auth.runInCallOrder(completion: completion) { turn in try await call(auth, turn) }
    }

    private func inVoidCallOrder(
        completion: (@Sendable (Error?) -> Void)?,
        _ call: @escaping @Sendable (Auth, OperationTurn) async throws -> Void
    ) {
        let auth: Auth
        do {
            auth = try attachedAuth()
        } catch {
            Task { completion?(error) }
            return
        }
        let turn = auth.takeTurn()
        Task {
            do {
                try await call(auth, turn)
                completion?(nil)
            } catch {
                completion?(error)
            }
        }
    }

    internal func update(from wire: [String: AnySendable]) {
        lock.lock()
        defer { lock.unlock() }
        if let email = wire["email"] {
            self._email = email.stringValue
        }
        if let displayName = wire["displayName"] {
            self._displayName = displayName.stringValue
        }
        if let photoURLVal = wire["photoURL"] {
            self._photoURL = photoURLVal.stringValue.flatMap { URL(string: $0) }
        }
        if let phoneNumber = wire["phoneNumber"] {
            self._phoneNumber = phoneNumber.stringValue
        }
        if let isAnonymous = wire["isAnonymous"]?.boolValue {
            self._isAnonymous = isAnonymous
        }
        if let emailVerified = wire["emailVerified"]?.boolValue {
            self._isEmailVerified = emailVerified
        }
        if let providerId = wire["providerId"]?.stringValue {
            self._providerID = Self.normalizeTopLevelProviderID(providerId)
        }
        if let providerArr = wire["providerData"]?.arrayValue {
            self._providerData = providerArr.compactMap { item in
                item.dictionaryValue.map { UserInfoImpl.fromWire($0) }
            }
        }
        if let tenant = wire["tenantId"] {
            self._tenant = tenant.stringValue
        } else if let tenant = wire["tenant"] {
            self._tenant = tenant.stringValue
        }
        if let claims = wire["customClaims"]?.dictionaryValue ?? wire["claims"]?.dictionaryValue {
            self._claims = claims
        }
        if let metaDict = wire["metadata"]?.dictionaryValue {
            self._metadata = UserMetadata.fromWire(metaDict, fallbackDate: self._metadata.creationDate ?? Date())
        }
    }

    internal func replaceClaims(_ claims: [String: AnySendable]) {
        lock.lock()
        defer { lock.unlock() }
        self._claims = claims
    }

    private func setClaims(_ claims: [String: AnySendable]) {
        replaceClaims(claims)
    }

    public static func fromWire(auth: Auth?, wire: AnySendable) -> User? {
        guard let dict = wire.dictionaryValue,
              let uid = dict["uid"]?.stringValue else {
            return nil
        }
        let email = dict["email"]?.stringValue
        let displayName = dict["displayName"]?.stringValue
        let photoURL = dict["photoURL"]?.stringValue.flatMap { URL(string: $0) }
        let phoneNumber = dict["phoneNumber"]?.stringValue
        let isAnonymous = dict["isAnonymous"]?.boolValue ?? false
        let emailVerified = dict["emailVerified"]?.boolValue ?? false
        let providerID = normalizeTopLevelProviderID(dict["providerId"]?.stringValue)
        let tenant = dict["tenantId"]?.stringValue ?? dict["tenant"]?.stringValue
        let claims = dict["customClaims"]?.dictionaryValue ?? dict["claims"]?.dictionaryValue ?? [:]
        let providerData = (dict["providerData"]?.arrayValue ?? []).compactMap { item in
            item.dictionaryValue.map { UserInfoImpl.fromWire($0) }
        }
        let metadata = UserMetadata.fromWire(dict["metadata"]?.dictionaryValue)

        return User(
            auth: auth,
            uid: uid,
            email: email,
            displayName: displayName,
            photoURL: photoURL,
            phoneNumber: phoneNumber,
            isAnonymous: isAnonymous,
            isEmailVerified: emailVerified,
            providerID: providerID,
            providerData: providerData,
            tenant: tenant,
            claims: claims,
            metadata: metadata
        )
    }
}
