import Foundation

internal enum DatabaseInstanceResolver {
    private static let defaultDatabaseURL = "https://default.firebaseio.com"

    internal static func resolveInstanceName(from databaseURL: String?) -> String? {
        guard let raw = databaseURL else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return nil
        }
        if trimmed.lowercased() == defaultDatabaseURL || trimmed.lowercased() == "default" {
            return nil
        }

        if let components = URLComponents(string: trimmed) {
            if let nsValue = components.queryItems?
                .first(where: { $0.name == "ns" })?
                .value?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !nsValue.isEmpty {
                return normalizeCandidate(nsValue)
            }

            if let host = components.host?.lowercased(), !host.isEmpty {
                if host == "localhost" || isIPv4Address(host) {
                    return nil
                }
                let labels = host.split(separator: ".").map(String.init)
                if labels.count > 2, let first = labels.first, !first.isEmpty {
                    return normalizeCandidate(first)
                }
                return nil
            }

            if components.scheme != nil {
                return nil
            }
        }

        if isBareInstanceName(trimmed) {
            return normalizeCandidate(trimmed)
        }
        return nil
    }

    private static func normalizeCandidate(_ value: String) -> String? {
        let lower = value.lowercased()
        if lower.isEmpty || lower == "default" {
            return nil
        }
        return lower
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
