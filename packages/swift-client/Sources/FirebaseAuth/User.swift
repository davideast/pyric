import Foundation
import PyricFirestore

/// Represents an authenticated user identity within Firebase Authentication.
public final class User: @unchecked Sendable, UserInfo {
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
    public var claims: [String: AnySendable] {
        lock.lock(); defer { lock.unlock() }; return _claims
    }
    public var customClaims: [String: AnySendable] {
        claims
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
        providerID: String = "firebase",
        providerData: [UserInfoImpl] = [],
        tenant: String? = nil,
        claims: [String: AnySendable] = [:]
    ) {
        self.auth = auth
        self.uid = uid
        self._email = email
        self._displayName = displayName
        self._photoURL = photoURL
        self._phoneNumber = phoneNumber
        self._isAnonymous = isAnonymous
        self._isEmailVerified = isEmailVerified
        self._providerID = providerID
        self._providerData = providerData
        self._tenant = tenant
        self._claims = claims
    }

    // ── ID Tokens ────────────────────────────────────────────────────────────

    public func getIDToken(forcingRefresh: Bool = false) async throws -> String {
        guard let auth = self.auth else {
            throw AuthError(code: .noCurrentUser, message: "User is not attached to an active Auth instance.")
        }
        do {
            let token = try await auth.bridgeClient.authGetIdToken(forcingRefresh: forcingRefresh)
            if forcingRefresh {
                auth.notifyIdTokenChanged(user: self)
            }
            return token
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func getIDToken(
        forcingRefresh: Bool = false,
        completion: @escaping @Sendable (String?, Error?) -> Void
    ) {
        Task {
            do {
                let token = try await self.getIDToken(forcingRefresh: forcingRefresh)
                completion(token, nil)
            } catch {
                completion(nil, error)
            }
        }
    }

    public func getIDTokenResult(forcingRefresh: Bool = false) async throws -> AuthTokenResult {
        guard let auth = self.auth else {
            throw AuthError(code: .noCurrentUser, message: "User is not attached to an active Auth instance.")
        }
        do {
            let wire = try await auth.bridgeClient.authGetIdTokenResult(forcingRefresh: forcingRefresh)
            guard let dict = wire.dictionaryValue else {
                throw AuthError(code: .internalError, message: "Malformed getIdTokenResult response")
            }
            let res = AuthTokenResult.fromWire(dict)
            self.setClaims(res.claims)
            if forcingRefresh {
                auth.notifyIdTokenChanged(user: self)
            }
            return res
        } catch {
            throw AuthError.from(error: error)
        }
    }

    public func getIDTokenResult(
        forcingRefresh: Bool = false,
        completion: @escaping @Sendable (AuthTokenResult?, Error?) -> Void
    ) {
        Task {
            do {
                let result = try await self.getIDTokenResult(forcingRefresh: forcingRefresh)
                completion(result, nil)
            } catch {
                completion(nil, error)
            }
        }
    }

    // ── Profile Updates ──────────────────────────────────────────────────────

    public func updateProfile(displayName: String?, photoURL: URL?) async throws {
        guard let auth = self.auth else {
            throw AuthError(code: .noCurrentUser, message: "User is not attached to an active Auth instance.")
        }
        do {
            let reply = try await auth.bridgeClient.authUpdateProfile(
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
        guard let auth = self.auth else {
            throw AuthError(code: .noCurrentUser, message: "User is not attached to an active Auth instance.")
        }
        do {
            let reply = try await auth.bridgeClient.authGetCurrentUser()
            if let dict = reply.dictionaryValue {
                self.update(from: dict)
                auth.notifyUserUpdated(self)
            }
        } catch {
            throw AuthError.from(error: error)
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
        if let photoURL = wire["photoURL"]?.stringValue {
            self._photoURL = URL(string: photoURL)
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
            self._providerID = providerId
        }
        if let providerArr = wire["providerData"]?.arrayValue {
            self._providerData = providerArr.compactMap { item in
                item.dictionaryValue.map { UserInfoImpl.fromWire($0) }
            }
        }
        if let tenant = wire["tenant"]?.stringValue {
            self._tenant = tenant
        }
        if let claims = wire["customClaims"]?.dictionaryValue ?? wire["claims"]?.dictionaryValue {
            self._claims = claims
        }
    }

    private func setClaims(_ claims: [String: AnySendable]) {
        lock.lock()
        defer { lock.unlock() }
        self._claims = claims
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
        let providerID = dict["providerId"]?.stringValue ?? "firebase"
        let tenant = dict["tenant"]?.stringValue
        let claims = dict["customClaims"]?.dictionaryValue ?? dict["claims"]?.dictionaryValue ?? [:]
        let providerData = (dict["providerData"]?.arrayValue ?? []).compactMap { item in
            item.dictionaryValue.map { UserInfoImpl.fromWire($0) }
        }

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
            claims: claims
        )
    }
}
