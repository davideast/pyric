import Foundation

/// Deterministic cursor-based pagination helper for `StorageReference.list(maxResults:pageToken:)`.
package enum StorageListPaginator {
    private enum EntryKind: String, Codable, Comparable {
        case prefix = "p"
        case item = "i"

        static func < (lhs: EntryKind, rhs: EntryKind) -> Bool {
            if lhs == rhs { return false }
            return lhs == .prefix
        }
    }

    private struct CursorPayload: Codable, Equatable {
        let v: Int
        let k: EntryKind
        let p: String
    }

    private struct OrderedEntry {
        let kind: EntryKind
        let reference: StorageReference
    }

    package static func validateArguments(
        maxResults: Int64?,
        pageToken: String?
    ) throws {
        if let maxResults, (maxResults <= 0 || maxResults > 1000) {
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "Argument 'maxResults' must be between 1 and 1000 inclusive."
            )
        }
        if let pageToken {
            let trimmed = pageToken.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                throw StorageErrorCode(
                    code: .invalidArgument,
                    message: "Invalid pagination pageToken: empty string."
                )
            }
            if decodeCursor(trimmed) == nil {
                guard let legacy = Int(trimmed), legacy >= 0 else {
                    throw StorageErrorCode(
                        code: .invalidArgument,
                        message: "Invalid pagination pageToken: '\(pageToken)'."
                    )
                }
            }
        }
    }

    package static func paginate(
        prefixes: [StorageReference],
        items: [StorageReference],
        maxResults: Int64?,
        pageToken: String?
    ) throws -> StorageListResult {
        let sortedPrefixes = prefixes.sorted { $0.fullPath < $1.fullPath }
        let sortedItems = items.sorted { $0.fullPath < $1.fullPath }

        guard let maxResults else {
            return StorageListResult(
                prefixes: sortedPrefixes,
                items: sortedItems,
                pageToken: nil
            )
        }

        guard maxResults > 0 && maxResults <= 1000 else {
            throw StorageErrorCode(
                code: .invalidArgument,
                message: "Argument 'maxResults' must be between 1 and 1000 inclusive."
            )
        }

        var combined: [OrderedEntry] = []
        combined.reserveCapacity(sortedPrefixes.count + sortedItems.count)
        for prefixRef in sortedPrefixes {
            combined.append(OrderedEntry(kind: .prefix, reference: prefixRef))
        }
        for itemRef in sortedItems {
            combined.append(OrderedEntry(kind: .item, reference: itemRef))
        }

        let startIndex: Int
        if let pageToken {
            let trimmed = pageToken.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                throw StorageErrorCode(
                    code: .invalidArgument,
                    message: "Invalid pagination pageToken: empty string."
                )
            }
            if let cursor = decodeCursor(trimmed) {
                startIndex = combined.firstIndex { entry in
                    if entry.kind != cursor.k {
                        return cursor.k < entry.kind
                    }
                    return entry.reference.fullPath > cursor.p
                } ?? combined.count
            } else if let legacyOffset = Int(trimmed), legacyOffset >= 0 {
                startIndex = legacyOffset
            } else {
                throw StorageErrorCode(
                    code: .invalidArgument,
                    message: "Invalid pagination pageToken: '\(pageToken)'."
                )
            }
        } else {
            startIndex = 0
        }

        guard startIndex < combined.count else {
            return StorageListResult(prefixes: [], items: [], pageToken: nil)
        }

        let limit = Int(maxResults)
        let endIndex = min(startIndex + limit, combined.count)
        var pagePrefixes: [StorageReference] = []
        var pageItems: [StorageReference] = []

        for idx in startIndex..<endIndex {
            let entry = combined[idx]
            switch entry.kind {
            case .prefix:
                pagePrefixes.append(entry.reference)
            case .item:
                pageItems.append(entry.reference)
            }
        }

        let nextToken: String?
        if endIndex < combined.count {
            let lastEmitted = combined[endIndex - 1]
            nextToken = encodeCursor(
                CursorPayload(
                    v: 1,
                    k: lastEmitted.kind,
                    p: lastEmitted.reference.fullPath
                )
            )
        } else {
            nextToken = nil
        }

        return StorageListResult(
            prefixes: pagePrefixes,
            items: pageItems,
            pageToken: nextToken
        )
    }

    private static func encodeCursor(_ payload: CursorPayload) -> String {
        guard let json = try? JSONEncoder().encode(payload) else {
            return ""
        }
        return json.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func decodeCursor(_ raw: String) -> CursorPayload? {
        var b64 = raw
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = b64.count % 4
        if remainder != 0 {
            b64 += String(repeating: "=", count: 4 - remainder)
        }
        guard let data = Data(base64Encoded: b64),
              let decoded = try? JSONDecoder().decode(CursorPayload.self, from: data),
              decoded.v == 1 else {
            return nil
        }
        return decoded
    }
}
