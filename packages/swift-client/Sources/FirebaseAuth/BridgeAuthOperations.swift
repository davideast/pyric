import Foundation
import PyricFirestore

extension PyricBridgeClient {

    public func authSignInEmail(email: String, password: String) async throws -> AnySendable {
        try await op(
            method: "auth.signInEmail",
            params: [
                "email": .string(email),
                "password": .string(password)
            ]
        )
    }

    public func authCreateUser(email: String, password: String) async throws -> AnySendable {
        try await op(
            method: "auth.createUser",
            params: [
                "email": .string(email),
                "password": .string(password)
            ]
        )
    }

    public func authSignInAnonymously() async throws -> AnySendable {
        try await op(
            method: "auth.signInAnonymously",
            params: [:]
        )
    }

    public func authSignOut() async throws {
        _ = try await op(
            method: "auth.signOut",
            params: [:]
        )
    }

    public func authGetIdToken(forcingRefresh: Bool = false) async throws -> String {
        let res = try await op(
            method: "auth.getIdToken",
            params: ["forceRefresh": .bool(forcingRefresh)]
        )
        guard let token = res.stringValue else {
            throw PyricBridgeError.internalError("Invalid token response from auth.getIdToken")
        }
        return token
    }

    public func authGetIdTokenResult(forcingRefresh: Bool = false) async throws -> AnySendable {
        try await op(
            method: "auth.getIdTokenResult",
            params: ["forceRefresh": .bool(forcingRefresh)]
        )
    }

    public func authGetCurrentUser() async throws -> AnySendable {
        try await op(
            method: "auth.getCurrentUser",
            params: [:]
        )
    }

    public func authUpdateProfile(displayName: String?, photoURL: String?) async throws -> AnySendable {
        var params: [String: AnySendable] = [:]
        if let displayName {
            params["displayName"] = .string(displayName)
        }
        if let photoURL {
            params["photoURL"] = .string(photoURL)
        }
        return try await op(
            method: "auth.updateProfile",
            params: params
        )
    }

    public func authRestorePortSession(uid: String) async throws -> AnySendable {
        try await op(
            method: "auth.restorePortSession",
            params: ["uid": .string(uid)]
        )
    }
}
