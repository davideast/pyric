import Foundation

/// Configuration options for a `FirebaseApp` instance, mirroring `FirebaseCore.FirebaseOptions`.
public final class FirebaseOptions: @unchecked Sendable, Equatable {
    public var googleAppID: String
    public var gcmSenderID: String
    public var projectID: String?
    public var databaseURL: String?
    public var apiKey: String?
    public var storageBucket: String?
    public var clientID: String?
    public var bundleID: String

    public init(googleAppID: String, gcmSenderID: String) {
        self.googleAppID = googleAppID
        self.gcmSenderID = gcmSenderID
        self.projectID = nil
        self.databaseURL = nil
        self.apiKey = nil
        self.storageBucket = nil
        self.clientID = nil
        self.bundleID = "dev.pyric.app"
    }

    public init(
        projectID: String? = nil,
        databaseURL: String? = nil,
        apiKey: String? = nil,
        googleAppID: String = "1:000000000000:ios:0000000000000000",
        storageBucket: String? = nil,
        clientID: String? = nil,
        bundleID: String = "dev.pyric.app"
    ) {
        self.projectID = projectID
        self.databaseURL = databaseURL
        self.apiKey = apiKey
        self.googleAppID = googleAppID
        self.gcmSenderID = "000000000000"
        self.storageBucket = storageBucket
        self.clientID = clientID
        self.bundleID = bundleID
    }

    public static func == (lhs: FirebaseOptions, rhs: FirebaseOptions) -> Bool {
        lhs.googleAppID == rhs.googleAppID
            && lhs.gcmSenderID == rhs.gcmSenderID
            && lhs.projectID == rhs.projectID
            && lhs.databaseURL == rhs.databaseURL
            && lhs.apiKey == rhs.apiKey
            && lhs.storageBucket == rhs.storageBucket
            && lhs.clientID == rhs.clientID
            && lhs.bundleID == rhs.bundleID
    }
}

/// Resolved WebSocket endpoint and `Host` header for a `PyricBridgeClient`.
public struct ResolvedBridgeEndpoint: Sendable, Equatable {
    public let endpoint: URL
    public let hostHeader: String

    public init(endpoint: URL, hostHeader: String) {
        self.endpoint = endpoint
        self.hostHeader = hostHeader
    }
}

package enum FirebaseBridgeEndpointResolver {
    package static let defaultHost = "127.0.0.1"
    package static let defaultPort = 5174
    package static let sandboxPath = "/__pyric/sandbox"

    package static func resolveDefault(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> ResolvedBridgeEndpoint {
        if let bridgeURL = nonEmpty(environment["PYRIC_BRIDGE_URL"]),
           let resolved = parseBridgeURL(bridgeURL) {
            return resolved
        }
        if let liveBridgeURL = nonEmpty(environment["PYRIC_LIVE_BRIDGE_URL"]),
           let resolved = parseBridgeURL(liveBridgeURL) {
            return resolved
        }
        return emulatorEndpoint(host: defaultHost, port: defaultPort, sslEnabled: false)
    }

    package static func parseBridgeURL(_ raw: String) -> ResolvedBridgeEndpoint? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }
        let withScheme = trimmed.contains("://") ? trimmed : "ws://\(trimmed)"
        guard var components = URLComponents(string: withScheme),
              let rawHost = components.host,
              !rawHost.isEmpty else {
            return nil
        }

        let normalizedScheme: String
        switch (components.scheme ?? "ws").lowercased() {
        case "https", "wss":
            normalizedScheme = "wss"
        case "http", "ws":
            normalizedScheme = "ws"
        default:
            return nil
        }
        components.scheme = normalizedScheme
        if components.path.isEmpty || components.path == "/" {
            components.path = sandboxPath
        }

        guard let endpoint = components.url else {
            return nil
        }
        let formattedHost = formatHost(rawHost)
        let hostHeader: String
        if let port = components.port {
            hostHeader = "\(formattedHost):\(port)"
        } else {
            hostHeader = formattedHost
        }
        return ResolvedBridgeEndpoint(endpoint: endpoint, hostHeader: hostHeader)
    }

    package static func emulatorEndpoint(
        host: String,
        port: Int,
        sslEnabled: Bool = false
    ) -> ResolvedBridgeEndpoint {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let stripped: String
        if let range = trimmed.range(of: "://") {
            stripped = String(trimmed[range.upperBound...])
        } else {
            stripped = trimmed
        }
        let hostOnly = stripped.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? defaultHost
        let formattedHost = formatHost(hostOnly.isEmpty ? defaultHost : hostOnly)
        let scheme = sslEnabled ? "wss" : "ws"
        let hostAndPort = "\(formattedHost):\(port)"
        let url = URL(string: "\(scheme)://\(hostAndPort)\(sandboxPath)")
            ?? URL(string: "ws://127.0.0.1:5174/__pyric/sandbox")!
        return ResolvedBridgeEndpoint(endpoint: url, hostHeader: hostAndPort)
    }

    package static func endpointFromHostSetting(
        _ hostSetting: String,
        sslEnabled: Bool
    ) -> ResolvedBridgeEndpoint {
        let trimmed = hostSetting.trimmingCharacters(in: .whitespacesAndNewlines)
        let scheme = sslEnabled ? "wss" : "ws"
        if let parsed = parseBridgeURL("\(scheme)://\(trimmed)") {
            return parsed
        }
        return emulatorEndpoint(host: defaultHost, port: defaultPort, sslEnabled: sslEnabled)
    }

    private static func formatHost(_ host: String) -> String {
        if host.contains(":") && !host.hasPrefix("[") && !host.hasSuffix("]") {
            return "[\(host)]"
        }
        return host
    }

    private static func nonEmpty(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}
