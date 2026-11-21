import Foundation
import PyricFirestore

extension PyricBridgeClient {
    private static let defaultAppCheckTtlMillis: Int64 = 3_600_000

    /// Mints or retrieves a standard App Check token via `appCheck.getToken`.
    public func appCheckGetToken(
        appId: String? = nil,
        projectId: String? = nil,
        provider: String? = nil,
        forcingRefresh: Bool = false
    ) async throws -> AppCheckToken {
        try await appCheckGetToken(
            turn: takeTurn(),
            appId: appId,
            projectId: projectId,
            provider: provider,
            forcingRefresh: forcingRefresh
        )
    }

    package func appCheckGetToken(
        turn: OperationTurn,
        appId: String?,
        projectId: String?,
        provider: String?,
        forcingRefresh: Bool
    ) async throws -> AppCheckToken {
        var params = Self.baseAppCheckParams(appId: appId, projectId: projectId, provider: provider)
        params["forceRefresh"] = .bool(forcingRefresh)
        let res = try await op(turn: turn, method: "appCheck.getToken", params: params)
        return try Self.decodeAppCheckToken(res)
    }

    /// Mints a short-lived single/limited-use App Check token via `appCheck.getLimitedUseToken`.
    public func appCheckGetLimitedUseToken(
        appId: String? = nil,
        projectId: String? = nil,
        provider: String? = nil
    ) async throws -> AppCheckToken {
        try await appCheckGetLimitedUseToken(
            turn: takeTurn(),
            appId: appId,
            projectId: projectId,
            provider: provider
        )
    }

    package func appCheckGetLimitedUseToken(
        turn: OperationTurn,
        appId: String?,
        projectId: String?,
        provider: String?
    ) async throws -> AppCheckToken {
        let params = Self.baseAppCheckParams(appId: appId, projectId: projectId, provider: provider)
        let res = try await op(turn: turn, method: "appCheck.getLimitedUseToken", params: params)
        return try Self.decodeAppCheckToken(res)
    }

    /// Dispatches a bridge operation attaching the active `AppCheck` token for `app` when available.
    public func opWithAppCheck(
        app: FirebaseApp,
        method: String,
        params: [String: AnySendable] = [:],
        actAs: AuthLens? = nil,
        timeout: TimeInterval? = nil
    ) async throws -> AnySendable {
        var merged = params
        if merged["appCheckToken"] == nil,
           let attached = await AppCheck.tokenForSharedRequest(app: app) {
            merged["appCheckToken"] = .string(attached)
        }
        return try await op(
            turn: takeTurn(),
            method: method,
            params: merged,
            actAs: actAs,
            timeout: timeout
        )
    }

    private static func baseAppCheckParams(
        appId: String?,
        projectId: String?,
        provider: String?
    ) -> [String: AnySendable] {
        var params: [String: AnySendable] = [:]
        if let appId, !appId.isEmpty {
            params["appId"] = .string(appId)
        }
        if let projectId, !projectId.isEmpty {
            params["projectId"] = .string(projectId)
        }
        if let provider, !provider.isEmpty {
            params["provider"] = .string(provider)
        }
        return params
    }

    private static func decodeAppCheckToken(_ raw: AnySendable) throws -> AppCheckToken {
        guard let dict = raw.dictionaryValue else {
            throw AppCheckError(
                code: .unknown,
                message: "App Check response from Pyric bridge was not an object."
            )
        }
        guard let token = dict["token"]?.stringValue, !token.isEmpty else {
            throw AppCheckError(
                code: .unknown,
                message: "App Check response from Pyric bridge lacked a non-empty token."
            )
        }
        let expireTimeMillis: Int64
        if let exact = dict["expireTimeMillis"]?.intValue {
            expireTimeMillis = exact
        } else if let dbl = dict["expireTimeMillis"]?.doubleValue {
            expireTimeMillis = Int64(dbl.rounded())
        } else {
            let fallbackNow = Int64((Date().timeIntervalSince1970 * 1000.0).rounded())
            expireTimeMillis = fallbackNow + defaultAppCheckTtlMillis
        }
        return AppCheckToken(token: token, expireTimeMillis: expireTimeMillis)
    }
}
