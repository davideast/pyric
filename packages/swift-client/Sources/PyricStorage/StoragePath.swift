import Foundation

/// Parsed Cloud Storage bucket and normalized object path.
package struct ParsedStorageLocation: Sendable, Equatable, Hashable {
    package let bucket: String
    package let fullPath: String

    package init(bucket: String, fullPath: String) {
        self.bucket = bucket
        self.fullPath = Self.normalizePath(fullPath)
    }

    /// Strips leading/trailing slashes and collapses consecutive internal slashes.
    package static func normalizePath(_ raw: String) -> String {
        guard !raw.isEmpty else {
            return ""
        }
        return raw
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)
            .joined(separator: "/")
    }

    /// Joins a normalized parent path and a child path, normalizing the result.
    package static func childPath(parent: String, child: String) -> String {
        let normalizedChild = normalizePath(child)
        guard !normalizedChild.isEmpty else {
            return normalizePath(parent)
        }
        let normalizedParent = normalizePath(parent)
        if normalizedParent.isEmpty {
            return normalizedChild
        }
        return "\(normalizedParent)/\(normalizedChild)"
    }

    /// Returns the parent path, or `nil` when already at the root (`""`).
    package static func parentPath(of fullPath: String) -> String? {
        let normalized = normalizePath(fullPath)
        guard !normalized.isEmpty else {
            return nil
        }
        guard let slashIndex = normalized.lastIndex(of: "/") else {
            return ""
        }
        return String(normalized[..<slashIndex])
    }

    /// Returns the final path segment (`""` for root).
    package static func lastComponent(of fullPath: String) -> String {
        let normalized = normalizePath(fullPath)
        guard !normalized.isEmpty else {
            return ""
        }
        guard let slashIndex = normalized.lastIndex(of: "/") else {
            return normalized
        }
        return String(normalized[normalized.index(after: slashIndex)...])
    }

    /// Parses a bucket-only URL (`gs://<bucket>` or `gs://<bucket>/`) for `Storage.storage(url:)`.
    package static func parseBucketURL(_ rawURL: String) throws -> String {
        let trimmed = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return ""
        }
        guard trimmed.hasPrefix("gs://") else {
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "Storage bucket URL must start with 'gs://': \(rawURL)"
            )
        }
        let location = try parseGSURI(trimmed)
        guard location.fullPath.isEmpty else {
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "Storage bucket cannot be initialized with a non-empty object path: \(rawURL)"
            )
        }
        return location.bucket
    }

    /// Normalizes a configured `FirebaseOptions.storageBucket` string (`"my-bucket"` or `"gs://my-bucket/"`).
    package static func normalizeConfiguredBucket(_ rawBucket: String) -> String {
        let trimmed = rawBucket.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return ""
        }
        if trimmed.hasPrefix("gs://") {
            let remainder = String(trimmed.dropFirst("gs://".count))
            let bucketPart = remainder.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? ""
            return bucketPart
        }
        return trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    /// Parses a `gs://`, `http://`, or `https://` Firebase Storage URL into `(bucket, fullPath)`.
    package static func parseReferenceURL(_ rawURL: String) throws -> ParsedStorageLocation {
        let trimmed = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("gs://") {
            return try parseGSURI(trimmed)
        }
        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
            return try parseHTTPURL(trimmed)
        }
        throw StorageErrorCode(
            code: .pathError,
            message: "URL scheme must be one of gs://, http://, or https://"
        )
    }

    private static func parseGSURI(_ uri: String) throws -> ParsedStorageLocation {
        let afterScheme = String(uri.dropFirst("gs://".count))
        guard !afterScheme.isEmpty else {
            throw StorageErrorCode(
                code: .pathError,
                message: "URI must be in the form of gs://<bucket>/<path/to/object>"
            )
        }
        if let slashIndex = afterScheme.firstIndex(of: "/") {
            let bucket = String(afterScheme[..<slashIndex])
            guard !bucket.isEmpty else {
                throw StorageErrorCode(
                    code: .pathError,
                    message: "URI must include a non-empty bucket name: \(uri)"
                )
            }
            let rawObject = String(afterScheme[afterScheme.index(after: slashIndex)...])
            return ParsedStorageLocation(bucket: bucket, fullPath: rawObject)
        }
        return ParsedStorageLocation(bucket: afterScheme, fullPath: "")
    }

    /// Parses both production GCS/Firebase download URLs (`/v0/b/<bucket>/o/<encodedPath>`)
    /// and Pyric's hosted byte-route URLs (`/__pyric/storage/v0/b/<bucket>/o/<encodedPath>`).
    private static func parseHTTPURL(_ urlString: String) throws -> ParsedStorageLocation {
        guard let components = URLComponents(string: urlString) else {
            throw StorageErrorCode(
                code: .pathError,
                message: "URL must be in the form of http[s]://<host>/v0/b/<bucket>/o/<path/to/object>"
            )
        }
        let rawEncodedPath = components.percentEncodedPath
        let prefixes = ["/__pyric/storage/v0/b/", "/v0/b/"]
        var matchedTail: String?
        for prefix in prefixes where rawEncodedPath.hasPrefix(prefix) {
            matchedTail = String(rawEncodedPath.dropFirst(prefix.count))
            break
        }
        guard let tail = matchedTail, !tail.isEmpty else {
            throw StorageErrorCode(
                code: .pathError,
                message: "URL must be in the form of http[s]://<host>/v0/b/<bucket>/o/<path/to/object>"
            )
        }

        let bucketEncoded: String
        let afterBucket: String
        if let slashIdx = tail.firstIndex(of: "/") {
            bucketEncoded = String(tail[..<slashIdx])
            afterBucket = String(tail[tail.index(after: slashIdx)...])
        } else {
            bucketEncoded = tail
            afterBucket = ""
        }

        guard let bucket = bucketEncoded.removingPercentEncoding, !bucket.isEmpty else {
            throw StorageErrorCode(
                code: .pathError,
                message: "URL is missing a valid bucket segment: \(urlString)"
            )
        }

        if afterBucket.isEmpty || afterBucket == "o" || afterBucket == "o/" {
            return ParsedStorageLocation(bucket: bucket, fullPath: "")
        }
        guard afterBucket.hasPrefix("o/") else {
            throw StorageErrorCode(
                code: .pathError,
                message: "URL must be in the form of http[s]://<host>/v0/b/<bucket>/o/<path/to/object>"
            )
        }
        let encodedObject = String(afterBucket.dropFirst(2))
        guard let decodedObject = encodedObject.removingPercentEncoding else {
            throw StorageErrorCode(
                code: .pathError,
                message: "URL contains invalid percent-encoding in object path: \(urlString)"
            )
        }
        return ParsedStorageLocation(bucket: bucket, fullPath: decodedObject)
    }
}
