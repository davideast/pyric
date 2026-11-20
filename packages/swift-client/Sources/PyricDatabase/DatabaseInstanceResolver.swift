import Foundation

internal enum DatabaseURLValidationError: Error, LocalizedError, Equatable, Sendable {
    case emptyURL
    case malformedURL(String)
    case unsupportedScheme(String)
    case fragmentNotAllowed(String)
    case invalidPathSegment(String)
    case hostMismatch(found: String, expected: String)

    var errorDescription: String? {
        switch self {
        case .emptyURL:
            return "Invalid empty URL passed to reference(fromURL:)."
        case .malformedURL(let raw):
            return "Invalid URL (\(raw)) passed to reference(fromURL:)."
        case .unsupportedScheme(let scheme):
            return "Unsupported URL scheme (\(scheme)) passed to reference(fromURL:); expected http or https."
        case .fragmentNotAllowed(let raw):
            return "Database URL (\(raw)) must not contain a URL fragment ('#')."
        case .invalidPathSegment(let segment):
            return "Invalid path segment (\(segment)) in URL passed to reference(fromURL:); paths must not contain '.', '#', '$', '[', or ']'."
        case .hostMismatch(let found, let expected):
            return "Invalid URL host (\(found)) passed to reference(fromURL:). URL was expected to match configured Database URL host: \(expected)"
        }
    }
}

internal enum DatabaseInstanceResolver {
    internal static let defaultDatabaseURL = "https://default.firebaseio.com"

    internal static func normalizeDatabaseURL(_ rawURL: String) -> String {
        var trimmed = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.count > 1 && trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        if trimmed.isEmpty {
            return defaultDatabaseURL
        }
        return trimmed
    }

    internal static func canonicalInstanceKey(
        from databaseURL: String?,
        projectID: String? = nil
    ) -> String {
        if let resolved = resolveInstanceName(from: databaseURL, projectID: projectID) {
            return "instance:\(resolved)"
        }
        guard let raw = databaseURL?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            return "instance:<default>"
        }
        let lower = normalizeDatabaseURL(raw).lowercased()
        if lower == defaultDatabaseURL || lower == "default" {
            return "instance:<default>"
        }
        let normalized = lower.contains("://") ? lower : "https://\(lower)"
        guard let components = URLComponents(string: normalized),
              let host = components.host?.lowercased(),
              !host.isEmpty else {
            return "instance:<default>"
        }
        if let nsValue = components.queryItems?
            .first(where: { $0.name == "ns" })?
            .value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
           !nsValue.isEmpty {
            if isDefaultInstanceToken(nsValue, projectID: projectID) {
                return "instance:<default>"
            }
        }
        if host == "localhost" || isIPv4Address(host) {
            return "instance:<default>"
        }
        if isFirebaseHostedDomain(host) {
            return "instance:<default>"
        }
        if let port = components.port {
            return "host:\(host):\(port)"
        }
        return "host:\(host)"
    }

    internal static func resolveInstanceName(
        from databaseURL: String?,
        projectID: String? = nil
    ) -> String? {
        guard let raw = databaseURL else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return nil
        }
        let cleanTrimmed = normalizeDatabaseURL(trimmed)
        if cleanTrimmed.lowercased() == defaultDatabaseURL || cleanTrimmed.lowercased() == "default" {
            return nil
        }

        if isBareInstanceName(cleanTrimmed) {
            return normalizeCandidate(cleanTrimmed, projectID: projectID)
        }

        let normalized = cleanTrimmed.contains("://") ? cleanTrimmed : "https://\(cleanTrimmed)"
        guard let components = URLComponents(string: normalized) else {
            return nil
        }

        if let nsValue = components.queryItems?
            .first(where: { $0.name == "ns" })?
            .value?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !nsValue.isEmpty {
            return normalizeCandidate(nsValue, projectID: projectID)
        }

        if let host = components.host?.lowercased(), !host.isEmpty {
            if host == "localhost" || isIPv4Address(host) {
                return nil
            }
            let labels = host.split(separator: ".").map(String.init)
            if labels.count > 2, let first = labels.first, !first.isEmpty {
                return normalizeCandidate(first, projectID: projectID)
            }
        }
        return nil
    }

    internal static func validateReferenceURL(
        _ rawURL: String,
        databaseURL: String,
        emulatorHost: String?,
        projectID: String? = nil
    ) throws -> String {
        let trimmed = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            throw DatabaseURLValidationError.emptyURL
        }
        guard trimmed.contains("://") else {
            throw DatabaseURLValidationError.malformedURL(rawURL)
        }
        if trimmed.contains("#") {
            throw DatabaseURLValidationError.fragmentNotAllowed(rawURL)
        }
        guard let components = URLComponents(string: trimmed) else {
            throw DatabaseURLValidationError.malformedURL(rawURL)
        }
        guard let scheme = components.scheme?.lowercased(), !scheme.isEmpty else {
            throw DatabaseURLValidationError.malformedURL(rawURL)
        }
        guard scheme == "http" || scheme == "https" else {
            throw DatabaseURLValidationError.unsupportedScheme(scheme)
        }
        guard let foundHost = components.host?.lowercased(), !foundHost.isEmpty else {
            throw DatabaseURLValidationError.malformedURL(rawURL)
        }
        if components.fragment != nil {
            throw DatabaseURLValidationError.fragmentNotAllowed(rawURL)
        }

        let foundHostPort = formatHostPort(host: foundHost, port: components.port)
        let normalizedDbURL = databaseURL.contains("://") ? databaseURL : "https://\(databaseURL)"
        let expectedComponents = URLComponents(string: normalizedDbURL)
        let expectedHost = expectedComponents?.host?.lowercased() ?? "default.firebaseio.com"
        let expectedHostPort = formatHostPort(host: expectedHost, port: expectedComponents?.port)

        let expectedInstance = resolveInstanceName(from: databaseURL, projectID: projectID)
        let foundInstance = resolveInstanceName(from: trimmed, projectID: projectID)
        let hasExplicitNsQuery = components.queryItems?.contains(where: { $0.name == "ns" }) == true

        let matchesConfiguredHost = (foundHostPort == expectedHostPort)
            && (!hasExplicitNsQuery || foundInstance == expectedInstance)

        var matchesEmulatorHost = false
        if let rawEmulator = emulatorHost?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
           !rawEmulator.isEmpty {
            let emulatorBareHost = rawEmulator.split(separator: ":").first.map(String.init) ?? rawEmulator
            if foundHostPort == rawEmulator || foundHost == emulatorBareHost {
                if foundInstance == expectedInstance {
                    matchesEmulatorHost = true
                }
            }
        }

        if !matchesConfiguredHost && !matchesEmulatorHost {
            throw DatabaseURLValidationError.hostMismatch(
                found: foundHostPort,
                expected: expectedHostPort
            )
        }

        let rawSegments = components.percentEncodedPath
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)

        if rawSegments.isEmpty {
            return "/"
        }

        var decodedSegments: [String] = []
        decodedSegments.reserveCapacity(rawSegments.count)
        for (index, rawSeg) in rawSegments.enumerated() {
            guard let decoded = rawSeg.removingPercentEncoding, !decoded.isEmpty else {
                throw DatabaseURLValidationError.malformedURL(rawURL)
            }
            if index == 0 && decoded == ".info" {
                decodedSegments.append(decoded)
                continue
            }
            if containsForbiddenPathCharacter(decoded) {
                throw DatabaseURLValidationError.invalidPathSegment(decoded)
            }
            decodedSegments.append(decoded)
        }

        return "/" + decodedSegments.joined(separator: "/")
    }

    private static func formatHostPort(host: String, port: Int?) -> String {
        if let port {
            return "\(host):\(port)"
        }
        return host
    }

    private static func isFirebaseHostedDomain(_ host: String) -> Bool {
        host.hasSuffix(".firebaseio.com")
            || host.hasSuffix(".firebasedatabase.app")
            || host.hasSuffix(".firebaseio-demo.com")
    }

    private static func isDefaultInstanceToken(_ token: String, projectID: String?) -> Bool {
        if token == "default" {
            return true
        }
        guard let cleanProj = projectID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !cleanProj.isEmpty else {
            return false
        }
        return token == cleanProj || token == "\(cleanProj)-default-rtdb"
    }

    private static func normalizeCandidate(_ value: String, projectID: String?) -> String? {
        let lower = value.lowercased()
        if lower.isEmpty || !isBareInstanceName(lower) {
            return nil
        }
        if isDefaultInstanceToken(lower, projectID: projectID) {
            return nil
        }
        return lower
    }

    private static func containsForbiddenPathCharacter(_ segment: String) -> Bool {
        for scalar in segment.unicodeScalars {
            let v = scalar.value
            if v <= 0x1F || v == 0x7F {
                return true
            }
            // '.', '#', '$', '[', ']'
            if v == 0x2E || v == 0x23 || v == 0x24 || v == 0x5B || v == 0x5D {
                return true
            }
        }
        return false
    }

    private static func isIPv4Address(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else {
            return false
        }
        for part in parts {
            guard let num = Int(part), num >= 0 && num <= 255, String(num) == part else {
                return false
            }
        }
        return true
    }

    private static func isBareInstanceName(_ value: String) -> Bool {
        guard let first = value.unicodeScalars.first, isAsciiAlphanumeric(first) else {
            return false
        }
        for scalar in value.unicodeScalars {
            if !isAsciiAlphanumeric(scalar) && scalar.value != 45 {
                return false
            }
        }
        return true
    }

    private static func isAsciiAlphanumeric(_ scalar: UnicodeScalar) -> Bool {
        let v = scalar.value
        return (v >= 48 && v <= 57) || (v >= 65 && v <= 90) || (v >= 97 && v <= 122)
    }
}
