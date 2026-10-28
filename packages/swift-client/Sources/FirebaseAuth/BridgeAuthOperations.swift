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

    public func authUpdateProfile(displayName: String?, photoURL: String?) async throws -> AnySendable {
        try await authUpdateProfile(turn: takeTurn(), displayName: displayName, photoURL: photoURL)
    }

    package func authUpdateProfile(
        turn: OperationTurn,
        displayName: String?,
        photoURL: String?
    ) async throws -> AnySendable {
        var params: [String: AnySendable] = [:]
        if let displayName {
            params["displayName"] = .string(displayName)
        }
        if let photoURL {
            params["photoURL"] = .string(photoURL)
        }
        return try await op(turn: turn, method: "auth.updateProfile", params: params)
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
