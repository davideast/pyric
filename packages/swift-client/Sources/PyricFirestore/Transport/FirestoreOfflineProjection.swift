import Foundation

internal enum OfflineWriteMutation: Sendable, Equatable {
    case set(path: String, encodedData: [String: AnySendable], merge: Bool, mergeFields: [String]?)
    case update(path: String, encodedFields: [String: AnySendable])
    case delete(path: String)

    var path: String {
        switch self {
        case .set(let path, _, _, _), .update(let path, _), .delete(let path):
            return path
        }
    }
}

internal struct CachedDocumentRecord: Sendable, Equatable {
    let exists: Bool
    let encodedFields: [String: AnySendable]?
}

internal struct ProjectedOfflineDoc: Sendable {
    let known: Bool
    let exists: Bool
    let hasPendingWrites: Bool
    let encodedFields: [String: AnySendable]?
    let wirePayload: AnySendable
}

internal enum FirestoreOfflineProjection {
    private static let deletedSentinelMarker = "__pyric_offline_deleted_field__"

    static func targetMatchesPath(_ target: TargetDescriptor, path: String) -> Bool {
        switch target {
        case .doc(let docPath):
            return docPath == path
        case .collection(let collPath):
            let prefix = "\(collPath)/"
            guard path.hasPrefix(prefix) else { return false }
            let suffix = path.dropFirst(prefix.count)
            return !suffix.isEmpty && !suffix.contains("/")
        case .group(let collectionId):
            let parts = path.split(separator: "/", omittingEmptySubsequences: false)
            return parts.count >= 2 && parts.count % 2 == 0 && String(parts[parts.count - 2]) == collectionId
        case .query(let sourceBox, _):
            return targetMatchesPath(sourceBox.value, path: path)
        }
    }

    static func projectDocument(
        path: String,
        baseRecord: CachedDocumentRecord?,
        stagedBatches: [[OfflineWriteMutation]]
    ) -> ProjectedOfflineDoc {
        var known = (baseRecord != nil)
        var current: [String: AnySendable]? = (baseRecord?.exists == true) ? (baseRecord?.encodedFields ?? [:]) : nil
        var hasPendingWrites = false
        let nowSeconds = Int64(Date().timeIntervalSince1970)

        for batch in stagedBatches {
            for mutation in batch where mutation.path == path {
                known = true
                hasPendingWrites = true
                switch mutation {
                case .delete:
                    current = nil
                case .update(_, let fields):
                    guard var existing = current else { continue }
                    let prior = existing
                    for (fieldKey, rawVal) in fields {
                        let segments = splitFieldPath(fieldKey)
                        let resolved = resolveSentinels(rawVal, priorRoot: prior, prefix: segments, nowSeconds: nowSeconds, keepDeletes: true)
                        existing = setField(in: existing, segments: segments, value: resolved)
                    }
                    current = existing
                case .set(_, let encodedData, let merge, let mergeFields):
                    let isMerge = merge || (mergeFields != nil)
                    let prior = isMerge ? current : nil
                    let resolvedMap = resolveMapSentinels(encodedData, priorRoot: prior, prefix: [], nowSeconds: nowSeconds, keepDeletes: isMerge)
                    if merge {
                        if let existing = current {
                            current = mergeMaps(base: existing, incoming: resolvedMap)
                        } else {
                            current = stripDeletedSentinels(fromMap: resolvedMap)
                        }
                    } else if let mergeFields {
                        var masked = current ?? [:]
                        for maskKey in mergeFields {
                            let segments = splitFieldPath(maskKey)
                            if let picked = readField(in: resolvedMap, segments: segments), !isDeletedMarker(picked) {
                                masked = setField(in: masked, segments: segments, value: stripDeletedSentinels(fromValue: picked))
                            } else {
                                masked = setField(in: masked, segments: segments, value: nil)
                            }
                        }
                        current = masked
                    } else {
                        current = stripDeletedSentinels(fromMap: resolvedMap)
                    }
                }
            }
        }

        let docId = path.split(separator: "/").last.map(String.init) ?? path
        var wireDict: [String: AnySendable] = [
            "id": .string(docId),
            "path": .string(path),
            "exists": .bool(current != nil),
            "isFromCache": .bool(true),
            "hasPendingWrites": .bool(hasPendingWrites)
        ]
        if let current {
            wireDict["data"] = .dictionary(current)
        }
        return ProjectedOfflineDoc(
            known: known,
            exists: current != nil,
            hasPendingWrites: hasPendingWrites,
            encodedFields: current,
            wirePayload: .dictionary(wireDict)
        )
    }

    static func projectQuery(
        target: TargetDescriptor,
        baseDocs: [String: CachedDocumentRecord],
        stagedBatches: [[OfflineWriteMutation]]
    ) -> AnySendable {
        var candidatePaths = Set(baseDocs.keys)
        for batch in stagedBatches {
            for mutation in batch {
                candidatePaths.insert(mutation.path)
            }
        }
        var projectedDocs: [(path: String, doc: ProjectedOfflineDoc)] = []
        for path in candidatePaths.sorted() where targetMatchesPath(target, path: path) {
            let projected = projectDocument(path: path, baseRecord: baseDocs[path], stagedBatches: stagedBatches)
            if projected.exists {
                projectedDocs.append((path: path, doc: projected))
            }
        }

        let filtered = applyQueryConstraints(target: target, candidates: projectedDocs)
        let anyPending = filtered.contains { $0.doc.hasPendingWrites }
        return .dictionary([
            "docs": .array(filtered.map { $0.doc.wirePayload }),
            "isFromCache": .bool(true),
            "hasPendingWrites": .bool(anyPending)
        ])
    }

    // MARK: - Field & Sentinel Helpers

    static func splitFieldPath(_ raw: String) -> [String] {
        raw.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    }

    private static func isSentinel(_ val: AnySendable, named kind: String) -> Bool {
        val["__sentinel"]?.stringValue == kind
    }

    private static func isDeletedMarker(_ val: AnySendable) -> Bool {
        val["__sentinel"]?.stringValue == deletedSentinelMarker || isSentinel(val, named: "deleteField")
    }

    private static func isScalarMarker(_ dict: [String: AnySendable]) -> Bool {
        if let t = dict["__type"]?.stringValue {
            return ["timestamp", "latlng", "bytes", "reference", "vector", "number"].contains(t)
        }
        if let t = dict["type"]?.stringValue {
            return [
                "firestore/timestamp/1.0",
                "firestore/geoPoint/1.0",
                "firestore/bytes/1.0",
                "firestore/vectorValue/1.0"
            ].contains(t)
        }
        return false
    }

    static func readField(in root: [String: AnySendable]?, segments: [String]) -> AnySendable? {
        guard let root, !segments.isEmpty else { return nil }
        var cur: AnySendable = .dictionary(root)
        for seg in segments {
            guard let dict = cur.dictionaryValue, !isScalarMarker(dict), let next = dict[seg] else {
                return nil
            }
            cur = next
        }
        return cur
    }

    private static func setField(
        in root: [String: AnySendable],
        segments: [String],
        value: AnySendable?
    ) -> [String: AnySendable] {
        guard let head = segments.first else { return root }
        var out = root
        if segments.count == 1 {
            if let value, !isDeletedMarker(value) {
                out[head] = stripDeletedSentinels(fromValue: value)
            } else {
                out.removeValue(forKey: head)
            }
            return out
        }
        var child: [String: AnySendable] = [:]
        if let existing = out[head]?.dictionaryValue, !isScalarMarker(existing) {
            child = existing
        }
        out[head] = .dictionary(setField(in: child, segments: Array(segments.dropFirst()), value: value))
        return out
    }

    private static func mergeMaps(
        base: [String: AnySendable],
        incoming: [String: AnySendable]
    ) -> [String: AnySendable] {
        var out = base
        for (key, val) in incoming {
            if isDeletedMarker(val) {
                out.removeValue(forKey: key)
                continue
            }
            if let incomingChild = val.dictionaryValue, !isScalarMarker(incomingChild) {
                if incomingChild.isEmpty {
                    out[key] = .dictionary([:])
                } else if let existingChild = out[key]?.dictionaryValue, !isScalarMarker(existingChild) {
                    out[key] = .dictionary(mergeMaps(base: existingChild, incoming: incomingChild))
                } else {
                    out[key] = .dictionary(stripDeletedSentinels(fromMap: incomingChild))
                }
            } else {
                out[key] = stripDeletedSentinels(fromValue: val)
            }
        }
        return out
    }

    private static func stripDeletedSentinels(fromMap map: [String: AnySendable]) -> [String: AnySendable] {
        var out: [String: AnySendable] = [:]
        for (key, val) in map where !isDeletedMarker(val) {
            out[key] = stripDeletedSentinels(fromValue: val)
        }
        return out
    }

    private static func stripDeletedSentinels(fromValue value: AnySendable) -> AnySendable {
        if let arr = value.arrayValue {
            return .array(arr.map(stripDeletedSentinels(fromValue:)))
        }
        if let dict = value.dictionaryValue, !isScalarMarker(dict) {
            return .dictionary(stripDeletedSentinels(fromMap: dict))
        }
        return value
    }

    private static func resolveMapSentinels(
        _ map: [String: AnySendable],
        priorRoot: [String: AnySendable]?,
        prefix: [String],
        nowSeconds: Int64,
        keepDeletes: Bool
    ) -> [String: AnySendable] {
        var out: [String: AnySendable] = [:]
        for (key, val) in map {
            let resolved = resolveSentinels(val, priorRoot: priorRoot, prefix: prefix + [key], nowSeconds: nowSeconds, keepDeletes: keepDeletes)
            if isDeletedMarker(resolved) && !keepDeletes {
                continue
            }
            out[key] = resolved
        }
        return out
    }

    private static func resolveSentinels(
        _ node: AnySendable,
        priorRoot: [String: AnySendable]?,
        prefix: [String],
        nowSeconds: Int64,
        keepDeletes: Bool
    ) -> AnySendable {
        if let arr = node.arrayValue {
            return .array(arr.map { resolveSentinels($0, priorRoot: priorRoot, prefix: [], nowSeconds: nowSeconds, keepDeletes: false) })
        }
        guard let dict = node.dictionaryValue else {
            return node
        }
        if let sentinel = dict["__sentinel"]?.stringValue {
            switch sentinel {
            case "deleteField":
                return .dictionary(["__sentinel": .string(deletedSentinelMarker)])
            case "serverTimestamp":
                return .dictionary(["__type": .string("timestamp"), "seconds": .int(nowSeconds), "nanos": .int(0)])
            case "increment":
                let prev = readField(in: priorRoot, segments: prefix)
                let addend = dict["n"]?.doubleValue ?? 0
                let base = prev?.doubleValue ?? 0
                if let intAdd = dict["n"]?.intValue, (prev == nil || prev?.intValue != nil) {
                    return .int((prev?.intValue ?? 0) + intAdd)
                }
                return .double(base + addend)
            case "arrayUnion":
                var items = readField(in: priorRoot, segments: prefix)?.arrayValue ?? []
                for raw in dict["values"]?.arrayValue ?? [] {
                    let resolved = resolveSentinels(raw, priorRoot: priorRoot, prefix: [], nowSeconds: nowSeconds, keepDeletes: false)
                    if !items.contains(where: { wireValuesEqual($0, resolved) }) {
                        items.append(resolved)
                    }
                }
                return .array(items)
            case "arrayRemove":
                let existing = readField(in: priorRoot, segments: prefix)?.arrayValue ?? []
                let removals = (dict["values"]?.arrayValue ?? []).map {
                    resolveSentinels($0, priorRoot: priorRoot, prefix: [], nowSeconds: nowSeconds, keepDeletes: false)
                }
                return .array(existing.filter { item in !removals.contains(where: { wireValuesEqual(item, $0) }) })
            default:
                break
            }
        }
        if isScalarMarker(dict) {
            return node
        }
        return .dictionary(resolveMapSentinels(dict, priorRoot: priorRoot, prefix: prefix, nowSeconds: nowSeconds, keepDeletes: keepDeletes))
    }
}
