import Foundation
import PyricFirestore

package struct ParsedRegionOrDomain: Sendable, Equatable {
    package let region: String
    package let customDomain: String?
}

package struct ResolvedCallableTarget: Sendable, Equatable {
    package let fetchURL: URL
    package let reportedURL: URL
}

/// Resolves callable function endpoints onto the local Pyric Functions HTTP gateway
/// or configured emulator while refusing off-machine origins before any network I/O.
package enum FunctionsURLResolver {
    package static let defaultRegion = "us-central1"
    package static let runServiceQuery = "?__pyric_run_service=1"

    package static func parseRegionOrCustomDomain(_ raw: String?) -> ParsedRegionOrDomain {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return ParsedRegionOrDomain(region: defaultRegion, customDomain: nil)
        }
        let lower = trimmed.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://"),
           let components = URLComponents(string: trimmed),
           let scheme = components.scheme,
           let host = components.host,
           !host.isEmpty {
            var rebuilt = URLComponents()
            rebuilt.scheme = scheme.lowercased()
            rebuilt.user = components.user
            rebuilt.password = components.password
            rebuilt.host = host
            rebuilt.port = components.port
            let trimmedPath = stripTrailingSlashes(components.path)
            rebuilt.path = trimmedPath == "/" ? "" : trimmedPath
            if let urlStr = rebuilt.string {
                return ParsedRegionOrDomain(
                    region: defaultRegion,
                    customDomain: stripTrailingSlashes(urlStr)
                )
            }
        }
        return ParsedRegionOrDomain(region: trimmed, customDomain: nil)
    }

    package static func normalizeCustomDomain(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return stripTrailingSlashes(trimmed)
    }

    /// Formats an emulator `(host, port)` pair into an `http(s)://<host>:<port>` origin,
    /// normalizing the Android emulator loopback alias `10.0.2.2` to `127.0.0.1`.
    package static func formatEmulatorOrigin(host: String, port: Int) -> String {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        precondition(!trimmed.isEmpty, "Emulator host must not be empty.")
        precondition((1...65535).contains(port), "Emulator port must be in 1...65535: \(port)")

        let lower = trimmed.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://"),
           var components = URLComponents(string: trimmed),
           let rawHost = components.host,
           !rawHost.isEmpty {
            components.host = rawHost == "10.0.2.2" ? "127.0.0.1" : rawHost
            components.port = port
            components.path = ""
            components.query = nil
            components.fragment = nil
            if let built = components.string {
                return stripTrailingSlashes(built)
            }
        }

        let unbracketed: String
        if trimmed.hasPrefix("[") && trimmed.hasSuffix("]") {
            unbracketed = String(trimmed.dropFirst().dropLast())
        } else {
            unbracketed = trimmed
        }
        let mappedHost = unbracketed == "10.0.2.2" ? "127.0.0.1" : unbracketed
        let formattedHost = mappedHost.contains(":") ? "[\(mappedHost)]" : mappedHost
        return "http://\(formattedHost):\(port)"
    }

    package static func resolveDefaultGatewayOrigin(
        app: FirebaseApp,
        environment: [String: String]
    ) -> String? {
        let explicitKeys = [
            "PYRIC_LIVE_FUNCTIONS_URL",
            "PYRIC_FUNCTIONS_BASE_URL",
            "PYRIC_FUNCTIONS_URL"
        ]
        for key in explicitKeys {
            if let candidate = nonEmpty(environment[key]) {
                return stripTrailingSlashes(rewriteLoopbackOriginString(candidate))
            }
        }

        if let bridgeHost = app.configuredBridgeHostSetting() {
            let scheme = bridgeHost.sslEnabled ? "https" : "http"
            return rewriteLoopbackOriginString("\(scheme)://\(bridgeHost.host)")
        }

        let bridgeKeys = [
            "PYRIC_LIVE_BRIDGE_URL",
            "PYRIC_BRIDGE_URL"
        ]
        for key in bridgeKeys {
            if let raw = nonEmpty(environment[key]),
               let origin = bridgeURLToHTTPOrigin(raw) {
                return origin
            }
        }

        return nil
    }

    package static func bridgeURLToHTTPOrigin(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }
        let withScheme = trimmed.contains("://") ? trimmed : "ws://\(trimmed)"
        guard let components = URLComponents(string: withScheme),
              let rawHost = components.host,
              !rawHost.isEmpty else {
            return nil
        }
        let scheme: String
        switch (components.scheme ?? "ws").lowercased() {
        case "ws", "http":
            scheme = "http"
        case "wss", "https":
            scheme = "https"
        default:
            return nil
        }
        let mappedHost = rawHost == "10.0.2.2" ? "127.0.0.1" : rawHost
        let formattedHost = (mappedHost.contains(":") && !mappedHost.hasPrefix("["))
            ? "[\(mappedHost)]"
            : mappedHost
        if let port = components.port {
            return "\(scheme)://\(formattedHost):\(port)"
        }
        return "\(scheme)://\(formattedHost)"
    }

    package static func isLoopbackHost(_ rawHost: String?) -> Bool {
        guard let rawHost, !rawHost.isEmpty else {
            return false
        }
        let unbracketed: String
        if rawHost.hasPrefix("[") && rawHost.hasSuffix("]") {
            unbracketed = String(rawHost.dropFirst().dropLast()).lowercased()
        } else {
            unbracketed = rawHost.lowercased()
        }
        return unbracketed == "127.0.0.1"
            || unbracketed == "localhost"
            || unbracketed == "::1"
            || unbracketed == "10.0.2.2"
    }

    package static func isSecureOrLoopback(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        return scheme == "https" || isLoopbackHost(url.host)
    }

    package static func resolveNamedTarget(
        name: String,
        projectID: String,
        region: String,
        customDomain: String?,
        emulatorOrigin: String?,
        gatewayOrigin: String?
    ) throws -> ResolvedCallableTarget {
        let cleanName = stripLeadingSlashes(name.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !cleanName.isEmpty else {
            throw FunctionsError(
                .invalidArgument,
                message: "Callable function name must not be empty.",
                region: region
            )
        }

        if let emulatorOrigin {
            let base = stripTrailingSlashes(rewriteLoopbackOriginString(emulatorOrigin))
            let effectiveProject = projectID.isEmpty ? "default" : projectID
            let rawTarget = "\(base)/\(effectiveProject)/\(region)/\(cleanName)"
            guard let url = URL(string: rawTarget) else {
                throw FunctionsError(.invalidArgument, message: "Invalid callable URL: \(rawTarget)", region: region)
            }
            return ResolvedCallableTarget(fetchURL: url, reportedURL: url)
        }

        if let customDomain {
            let cleanDomain = stripTrailingSlashes(customDomain)
            let reportedRaw = "\(cleanDomain)/\(cleanName)"
            guard let reportedURL = URL(string: reportedRaw) else {
                throw offMachineError(urlString: reportedRaw, region: region, url: nil)
            }
            if isAllowedLocalURL(reportedURL, gatewayOrigin: gatewayOrigin) {
                let fetchURL = rewriteLoopbackHostInURL(reportedURL)
                return ResolvedCallableTarget(fetchURL: fetchURL, reportedURL: reportedURL)
            }
            throw offMachineError(urlString: reportedRaw, region: region, url: reportedURL)
        }

        let reportedRaw = "https://\(region)-\(projectID).cloudfunctions.net/\(cleanName)"
        let reportedURL = URL(string: reportedRaw)
        guard let gatewayOrigin, !projectID.isEmpty else {
            throw offMachineError(urlString: reportedRaw, region: region, url: reportedURL)
        }
        let base = stripTrailingSlashes(rewriteLoopbackOriginString(gatewayOrigin))
        guard let baseURL = URL(string: base),
              isAllowedLocalURL(baseURL, gatewayOrigin: base),
              let fetchURL = URL(string: "\(base)/\(projectID)/\(region)/\(cleanName)") else {
            throw offMachineError(urlString: reportedRaw, region: region, url: reportedURL)
        }
        return ResolvedCallableTarget(
            fetchURL: fetchURL,
            reportedURL: reportedURL ?? fetchURL
        )
    }

    package static func resolveURLTarget(
        url: URL,
        projectID: String,
        region: String,
        emulatorOrigin: String?,
        gatewayOrigin: String?
    ) throws -> ResolvedCallableTarget {
        let rawString = url.absoluteString
        guard let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let rawHost = url.host,
              !rawHost.isEmpty else {
            throw FunctionsError(
                .invalidArgument,
                message: "Invalid callable URL: \(rawString)",
                region: region,
                url: url
            )
        }

        let activeGateway = (emulatorOrigin ?? gatewayOrigin).map {
            stripTrailingSlashes(rewriteLoopbackOriginString($0))
        }

        if isAllowedLocalURL(url, gatewayOrigin: activeGateway) {
            return ResolvedCallableTarget(
                fetchURL: rewriteLoopbackHostInURL(url),
                reportedURL: url
            )
        }

        guard scheme == "https", let base = activeGateway else {
            throw offMachineError(urlString: rawString, region: region, url: url)
        }

        let hostLower = rawHost.lowercased()
        let pathSegments = url.path
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)

        if hostLower.hasSuffix(".cloudfunctions.net") {
            guard pathSegments.count == 1, let fnName = pathSegments.first else {
                throw offMachineError(urlString: rawString, region: region, url: url)
            }
            let prefix = String(hostLower.dropLast(".cloudfunctions.net".count))
            if !projectID.isEmpty {
                let projectSuffix = "-\(projectID.lowercased())"
                guard prefix.hasSuffix(projectSuffix) else {
                    throw offMachineError(urlString: rawString, region: region, url: url)
                }
                let urlRegion = String(prefix.dropLast(projectSuffix.count))
                guard !urlRegion.isEmpty,
                      let fetchURL = URL(string: "\(base)/\(projectID)/\(urlRegion)/\(fnName)") else {
                    throw offMachineError(urlString: rawString, region: region, url: url)
                }
                return ResolvedCallableTarget(fetchURL: fetchURL, reportedURL: url)
            }
            throw offMachineError(urlString: rawString, region: region, url: url)
        }

        if pathSegments.isEmpty && !projectID.isEmpty {
            if let legacyService = matchLegacyRunHost(hostLower),
               let fetchURL = URL(string: "\(base)/\(projectID)/\(region)/\(legacyService)\(runServiceQuery)") {
                return ResolvedCallableTarget(fetchURL: fetchURL, reportedURL: url)
            }
            if let regional = matchRegionalRunHost(hostLower),
               let fetchURL = URL(string: "\(base)/\(projectID)/\(regional.region)/\(regional.service)\(runServiceQuery)") {
                return ResolvedCallableTarget(fetchURL: fetchURL, reportedURL: url)
            }
        }

        throw offMachineError(urlString: rawString, region: region, url: url)
    }

    // MARK: - Internal Helpers

    private static func isAllowedLocalURL(_ candidate: URL, gatewayOrigin: String?) -> Bool {
        guard let scheme = candidate.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return false
        }
        if let gatewayOrigin,
           let gwURL = URL(string: gatewayOrigin),
           sameOrigin(candidate, gwURL) {
            return true
        }
        return isLoopbackHost(candidate.host)
    }

    private static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
        let lhsScheme = (lhs.scheme ?? "").lowercased()
        let rhsScheme = (rhs.scheme ?? "").lowercased()
        let lhsHost = (lhs.host ?? "").lowercased()
        let rhsHost = (rhs.host ?? "").lowercased()
        let lhsPort = lhs.port ?? (lhsScheme == "https" ? 443 : 80)
        let rhsPort = rhs.port ?? (rhsScheme == "https" ? 443 : 80)
        return lhsScheme == rhsScheme && lhsHost == rhsHost && lhsPort == rhsPort
    }

    private static func rewriteLoopbackOriginString(_ raw: String) -> String {
        guard var components = URLComponents(string: raw),
              components.host == "10.0.2.2" else {
            return raw
        }
        components.host = "127.0.0.1"
        return components.string ?? raw
    }

    private static func rewriteLoopbackHostInURL(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.host == "10.0.2.2" else {
            return url
        }
        components.host = "127.0.0.1"
        return components.url ?? url
    }

    private static func matchLegacyRunHost(_ hostLower: String) -> String? {
        guard hostLower.hasSuffix(".a.run.app") else {
            return nil
        }
        let stem = String(hostLower.dropLast(".a.run.app".count))
        let parts = stem.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 3 else {
            return nil
        }
        let regionCode = parts[parts.count - 1]
        let hashPart = parts[parts.count - 2]
        let service = parts.dropLast(2).joined(separator: "-")
        guard regionCode.count == 2,
              regionCode.allSatisfy({ $0.isASCII && $0.isLetter }),
              !hashPart.isEmpty,
              hashPart.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }),
              !service.isEmpty else {
            return nil
        }
        return service
    }

    private static func matchRegionalRunHost(_ hostLower: String) -> (service: String, region: String)? {
        guard hostLower.hasSuffix(".run.app"), !hostLower.hasSuffix(".a.run.app") else {
            return nil
        }
        let withoutSuffix = String(hostLower.dropLast(".run.app".count))
        let dotParts = withoutSuffix.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard dotParts.count == 2 else {
            return nil
        }
        let serviceAndProjectNum = dotParts[0]
        let runRegion = dotParts[1]
        guard let lastDash = serviceAndProjectNum.lastIndex(of: "-") else {
            return nil
        }
        let service = String(serviceAndProjectNum[..<lastDash])
        let projectNum = String(serviceAndProjectNum[serviceAndProjectNum.index(after: lastDash)...])
        guard !service.isEmpty,
              !projectNum.isEmpty,
              projectNum.allSatisfy({ $0.isASCII && $0.isNumber }),
              !runRegion.isEmpty else {
            return nil
        }
        return (service: service, region: runRegion)
    }

    private static func offMachineError(urlString: String, region: String, url: URL?) -> FunctionsError {
        FunctionsError(
            .unavailable,
            message: "Pyric refused off-machine callable URL '\(urlString)'; only this project's cloudfunctions.net, run.app, and local gateway URLs are served.",
            region: region,
            url: url
        )
    }

    private static func stripTrailingSlashes(_ value: String) -> String {
        var result = value
        while result.hasSuffix("/") {
            result.removeLast()
        }
        return result
    }

    private static func stripLeadingSlashes(_ value: String) -> String {
        var result = value
        while result.hasPrefix("/") {
            result.removeFirst()
        }
        return result
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}
