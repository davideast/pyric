import Foundation
import PyricFirestore

// Each Auth operation has a form that sends in the place a turn holds, for an
// Auth or User call that took its turn where the app made it. The public forms
// take their turn when they reach the client.
extension PyricBridgeClient {

    public func authSignInEmail(email: String, password: String, tenantId: String? = nil) async throws -> AnySendable {
        try await authSignInEmail(turn: takeTurn(), email: email, password: password, tenantId: tenantId)
    }

    package func authSignInEmail(
        turn: OperationTurn,
        email: String,
        password: String,
        tenantId: String?
    ) async throws -> AnySendable {
        var params: [String: AnySendable] = [
            "email": .string(email),
            "password": .string(password)
        ]
        if let tenantId {
            params["tenantId"] = .string(tenantId)
        }
        return try await op(turn: turn, method: "auth.signInEmail", params: params)
    }

    public func authCreateUser(email: String, password: String, tenantId: String? = nil) async throws -> AnySendable {
        try await authCreateUser(turn: takeTurn(), email: email, password: password, tenantId: tenantId)
    }

    package func authCreateUser(
        turn: OperationTurn,
        email: String,
        password: String,
        tenantId: String?
    ) async throws -> AnySendable {
        var params: [String: AnySendable] = [
            "email": .string(email),
            "password": .string(password)
        ]
        if let tenantId {
            params["tenantId"] = .string(tenantId)
        }
        return try await op(turn: turn, method: "auth.createUser", params: params)
    }

    public func authSignInAnonymously(tenantId: String? = nil) async throws -> AnySendable {
        try await authSignInAnonymously(turn: takeTurn(), tenantId: tenantId)
    }

    package func authSignInAnonymously(turn: OperationTurn, tenantId: String?) async throws -> AnySendable {
        var params: [String: AnySendable] = [:]
        if let tenantId {
            params["tenantId"] = .string(tenantId)
        }
        return try await op(turn: turn, method: "auth.signInAnonymously", params: params)
    }

    public func authSignInWithCustomToken(customToken: String, tenantId: String? = nil) async throws -> AnySendable {
        try await authSignInWithCustomToken(turn: takeTurn(), customToken: customToken, tenantId: tenantId)
    }

    package func authSignInWithCustomToken(
        turn: OperationTurn,
        customToken: String,
        tenantId: String?
    ) async throws -> AnySendable {
        var params: [String: AnySendable] = [
            "customToken": .string(customToken)
        ]
        if let tenantId {
            params["tenantId"] = .string(tenantId)
        }
        return try await op(turn: turn, method: "auth.signInWithCustomToken", params: params)
    }

    public func authSignInWithCredential(params: [String: AnySendable], tenantId: String? = nil) async throws -> AnySendable {
        try await authSignInWithCredential(turn: takeTurn(), params: params, tenantId: tenantId)
    }

    package func authSignInWithCredential(
        turn: OperationTurn,
        params: [String: AnySendable],
        tenantId: String?
    ) async throws -> AnySendable {
        var merged = params
        if let tenantId {
            merged["tenantId"] = .string(tenantId)
        }
        return try await op(turn: turn, method: "auth.signInWithCredential", params: merged)
    }

    public func authSignOut() async throws {
        try await authSignOut(turn: takeTurn())
    }

    package func authSignOut(turn: OperationTurn) async throws {
        _ = try await op(turn: turn, method: "auth.signOut", params: [:])
    }

    public func authGetIdToken(forcingRefresh: Bool = false) async throws -> String {
        try await authGetIdToken(turn: takeTurn(), forcingRefresh: forcingRefresh)
    }

    package func authGetIdToken(turn: OperationTurn, forcingRefresh: Bool) async throws -> String {
        let res = try await op(
            turn: turn,
            method: "auth.getIdToken",
            params: ["forceRefresh": .bool(forcingRefresh)]
        )
        guard let token = res.stringValue else {
            throw PyricBridgeError.internalError("Invalid token response from auth.getIdToken")
        }
        return token
    }

    public func authGetIdTokenResult(forcingRefresh: Bool = false) async throws -> AnySendable {
        try await authGetIdTokenResult(turn: takeTurn(), forcingRefresh: forcingRefresh)
    }

    package func authGetIdTokenResult(turn: OperationTurn, forcingRefresh: Bool) async throws -> AnySendable {
        try await op(
            turn: turn,
            method: "auth.getIdTokenResult",
            params: ["forceRefresh": .bool(forcingRefresh)]
        )
    }

    public func authGetCurrentUser() async throws -> AnySendable {
        try await authGetCurrentUser(turn: takeTurn())
    }

    package func authGetCurrentUser(turn: OperationTurn) async throws -> AnySendable {
        try await op(turn: turn, method: "auth.getCurrentUser", params: [:])
    }

    public func authReload(uid: String? = nil) async throws -> AnySendable {
        try await authReload(turn: takeTurn(), uid: uid)
    }

    package func authReload(turn: OperationTurn, uid: String?) async throws -> AnySendable {
        var params: [String: AnySendable] = [:]
        if let uid {
            params["uid"] = .string(uid)
        }
        return try await op(turn: turn, method: "auth.reload", params: params)
    }

    public func authUpdateProfile(displayName: String?, photoURL: String?) async throws -> AnySendable {
        try await authUpdateProfile(turn: takeTurn(), displayName: displayName, photoURL: photoURL)
    }

    package func authUpdateProfile(
        turn: OperationTurn,
        displayName: String?,
        photoURL: String?
    ) async throws -> AnySendable {
        let params: [String: AnySendable] = [
            "displayName": displayName.map { .string($0) } ?? .null,
            "photoURL": photoURL.map { .string($0) } ?? .null,
        ]
        return try await op(turn: turn, method: "auth.updateProfile", params: params)
    }

    public func authDeleteUser() async throws {
        try await authDeleteUser(turn: takeTurn())
    }

    package func authDeleteUser(turn: OperationTurn) async throws {
        _ = try await op(turn: turn, method: "auth.deleteUser", params: [:])
    }

    public func authUpdatePassword(password: String) async throws -> AnySendable {
        try await authUpdatePassword(turn: takeTurn(), password: password)
    }

    package func authUpdatePassword(turn: OperationTurn, password: String) async throws -> AnySendable {
        try await op(
            turn: turn,
            method: "auth.updatePassword",
            params: ["password": .string(password)]
        )
    }

    public func authLinkWithCredential(
        uid: String,
        tenantId: String?,
        credentialParams: [String: AnySendable]
    ) async throws -> AnySendable {
        try await authLinkWithCredential(
            turn: takeTurn(),
            uid: uid,
            tenantId: tenantId,
            credentialParams: credentialParams
        )
    }

    package func authLinkWithCredential(
        turn: OperationTurn,
        uid: String,
        tenantId: String?,
        credentialParams: [String: AnySendable]
    ) async throws -> AnySendable {
        let params: [String: AnySendable] = [
            "uid": .string(uid),
            "tenantId": tenantId.map { .string($0) } ?? .null,
            "credential": .dictionary(credentialParams),
        ]
        return try await op(turn: turn, method: "auth.linkWithCredential", params: params)
    }

    public func authReauthenticateWithCredential(
        uid: String,
        tenantId: String?,
        credentialParams: [String: AnySendable]
    ) async throws -> AnySendable {
        try await authReauthenticateWithCredential(
            turn: takeTurn(),
            uid: uid,
            tenantId: tenantId,
            credentialParams: credentialParams
        )
    }

    package func authReauthenticateWithCredential(
        turn: OperationTurn,
        uid: String,
        tenantId: String?,
        credentialParams: [String: AnySendable]
    ) async throws -> AnySendable {
        let params: [String: AnySendable] = [
            "uid": .string(uid),
            "tenantId": tenantId.map { .string($0) } ?? .null,
            "credential": .dictionary(credentialParams),
        ]
        return try await op(turn: turn, method: "auth.reauthenticateWithCredential", params: params)
    }

    public func authUnlink(uid: String, tenantId: String?, providerID: String) async throws -> AnySendable {
        try await authUnlink(turn: takeTurn(), uid: uid, tenantId: tenantId, providerID: providerID)
    }

    package func authUnlink(
        turn: OperationTurn,
        uid: String,
        tenantId: String?,
        providerID: String
    ) async throws -> AnySendable {
        let params: [String: AnySendable] = [
            "uid": .string(uid),
            "tenantId": tenantId.map { .string($0) } ?? .null,
            "providerId": .string(providerID),
        ]
        return try await op(turn: turn, method: "auth.unlink", params: params)
    }

    public func authMockSignInResult(
        providerID: String,
        uid: String,
        email: String? = nil,
        displayName: String? = nil,
        photoURL: String? = nil,
        emailVerified: Bool? = nil,
        customClaims: [String: AnySendable] = [:]
    ) async throws {
        try await authMockSignInResult(
            turn: takeTurn(),
            providerID: providerID,
            uid: uid,
            email: email,
            displayName: displayName,
            photoURL: photoURL,
            emailVerified: emailVerified,
            customClaims: customClaims
        )
    }

    package func authMockSignInResult(
        turn: OperationTurn,
        providerID: String,
        uid: String,
        email: String?,
        displayName: String?,
        photoURL: String?,
        emailVerified: Bool?,
        customClaims: [String: AnySendable]
    ) async throws {
        var identity: [String: AnySendable] = [
            "providerId": .string(providerID),
            "uid": .string(uid),
            "email": email.map { .string($0) } ?? .null,
            "displayName": displayName.map { .string($0) } ?? .null,
            "photoURL": photoURL.map { .string($0) } ?? .null,
            "customClaims": .dictionary(customClaims),
        ]
        if let emailVerified {
            identity["emailVerified"] = .bool(emailVerified)
        }
        _ = try await op(
            turn: turn,
            method: "auth.mockSignInResult",
            params: ["identity": .dictionary(identity)]
        )
    }

    public func authRestorePortSession(uid: String, tenantId: String? = nil) async throws -> AnySendable {
        try await authRestorePortSession(turn: takeTurn(), uid: uid, tenantId: tenantId)
    }

    package func authRestorePortSession(turn: OperationTurn, uid: String, tenantId: String?) async throws -> AnySendable {
        var params: [String: AnySendable] = ["uid": .string(uid)]
        if let tenantId {
            params["tenantId"] = .string(tenantId)
        }
        return try await op(turn: turn, method: "auth.restorePortSession", params: params)
    }
}
