import Foundation

/// Resolves an App Check token string to attach onto outgoing bridge frames and
/// Storage HTTP byte-route requests.
package typealias BridgeAppCheckTokenProvider = @Sendable () async -> String?

package enum BridgeAppCheckAttachment {
    private static let internalMethods: Set<String> = [
        "sandbox.clock",
        "auth.restorePortSession",
    ]
    private static let internalSubTargets: Set<String> = [
        "authState",
        "idToken",
        "events",
        "presence",
    ]

    package static func attachToOpParams(
        method: String,
        params: [String: AnySendable],
        tokenProvider: BridgeAppCheckTokenProvider?
    ) async -> [String: AnySendable] {
        guard let tokenProvider else { return params }
        if method.hasPrefix("appCheck.") || internalMethods.contains(method) {
            return params
        }
        if let existing = params["appCheckToken"]?.stringValue, !existing.isEmpty {
            return params
        }
        guard let token = await tokenProvider(), !token.isEmpty else {
            return params
        }
        var copy = params
        copy["appCheckToken"] = .string(token)
        return copy
    }

    package static func isInternalSubscriptionTarget(_ target: AnySendable) -> Bool {
        guard let targetString = target.stringValue else { return false }
        return internalSubTargets.contains(targetString)
    }

    package static func attachToSubPayload(
        _ payload: [String: AnySendable],
        tokenProvider: BridgeAppCheckTokenProvider?
    ) async -> [String: AnySendable] {
        guard let tokenProvider else { return payload }
        if let existing = payload["appCheckToken"]?.stringValue, !existing.isEmpty {
            return payload
        }
        if let target = payload["target"], isInternalSubscriptionTarget(target) {
            return payload
        }
        guard let token = await tokenProvider(), !token.isEmpty else {
            return payload
        }
        var copy = payload
        copy["appCheckToken"] = .string(token)
        return copy
    }

    package static func attachHeader(
        to headers: [String: String],
        tokenProvider: BridgeAppCheckTokenProvider?
    ) async -> [String: String] {
        guard let tokenProvider else { return headers }
        for key in headers.keys {
            if key.caseInsensitiveCompare("X-Firebase-AppCheck") == .orderedSame {
                return headers
            }
        }
        guard let token = await tokenProvider(), !token.isEmpty else {
            return headers
        }
        var copy = headers
        copy["X-Firebase-AppCheck"] = token
        return copy
    }
}
