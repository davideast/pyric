import Foundation
import PyricFirestore

private struct WeakAuthLocaleEntry {
    weak var instance: Auth?
    var languageCode: String?
}

private enum AuthLocaleRegistry {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var entries: [ObjectIdentifier: WeakAuthLocaleEntry] = [:]

    static func get(for auth: Auth) -> String? {
        lock.lock()
        defer { lock.unlock() }
        pruneDeadEntriesLocked()
        return entries[ObjectIdentifier(auth)]?.languageCode
    }

    static func set(_ code: String?, for auth: Auth) {
        lock.lock()
        defer { lock.unlock() }
        pruneDeadEntriesLocked()
        let key = ObjectIdentifier(auth)
        if let code {
            entries[key] = WeakAuthLocaleEntry(instance: auth, languageCode: code)
        } else {
            entries.removeValue(forKey: key)
        }
    }

    private static func pruneDeadEntriesLocked() {
        entries = entries.filter { $0.value.instance != nil }
    }
}

extension Auth {
    /// Upstream firebase-ios-sdk property spelling for multi-tenant Auth configuration.
    public var tenantID: String? {
        get { tenantId }
        set { tenantId = newValue }
    }

    /// Localization language code applied to outbound Auth operations.
    public var languageCode: String? {
        get { AuthLocaleRegistry.get(for: self) }
        set { AuthLocaleRegistry.set(newValue, for: self) }
    }

    /// Populates languageCode from the host application's preferred locale.
    public func useAppLanguage() {
        let preferred = Locale.preferredLanguages.first ?? "en"
        let trimmed = preferred.trimmingCharacters(in: .whitespacesAndNewlines)
        AuthLocaleRegistry.set(trimmed.isEmpty ? "en" : trimmed, for: self)
    }

    internal func decodeUserCredentialWire(
        _ wire: AnySendable,
        existingUser: User? = nil
    ) async throws -> AuthDataResult {
        guard let dict = wire.dictionaryValue,
              let userWire = dict["user"],
              let userDict = userWire.dictionaryValue,
              let wireUid = userDict["uid"]?.stringValue else {
            throw AuthError(code: .internalError, message: "Invalid auth credentials reply shape")
        }
        let user: User
        if let existingUser, existingUser.uid == wireUid {
            existingUser.update(from: userDict)
            user = existingUser
        } else {
            guard let parsedUser = User.fromWire(auth: self, wire: userWire) else {
                throw AuthError(code: .internalError, message: "Invalid auth credentials reply shape")
            }
            user = parsedUser
        }
        if user.claims.isEmpty,
           let topClaims = dict["customClaims"]?.dictionaryValue ?? dict["claims"]?.dictionaryValue {
            user.replaceClaims(topClaims)
        }
        if !bridgeClient.hasInjectedChannel,
           user.claims["firebase"] == nil,
           let tokenWire = try? await bridgeClient.authGetIdTokenResult(forcingRefresh: false),
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
        let addInfoDict = dict["additionalUserInfo"]?.dictionaryValue
        let providerId = addInfoDict?["providerId"]?.stringValue ?? dict["providerId"]?.stringValue
        let isNewUser = addInfoDict?["isNewUser"]?.boolValue ?? (dict["operationType"]?.stringValue == "signIn")
        let additional = AdditionalUserInfo(providerID: providerId, isNewUser: isNewUser)
        let result = AuthDataResult(user: user, additionalUserInfo: additional)
        applyUserTransition(user)
        return result
    }
}
