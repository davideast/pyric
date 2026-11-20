import Foundation

internal struct BundledNamedQuerySpec: Sendable, Equatable {
    let name: String
    let collectionPath: String
    let isCollectionGroup: Bool
    let constraints: [QueryConstraintDescriptor]
}

internal struct BundledDocumentEntry: Sendable, Equatable {
    let docPath: String
    let exists: Bool
    let encodedFields: [String: AnySendable]?
    let bytesLoadedAfterDoc: Int
}

internal struct DecodedFirestoreBundle: Sendable, Equatable {
    let id: String
    let totalDocuments: Int
    let totalBytes: Int
    let namedQueries: [BundledNamedQuerySpec]
    let documents: [BundledDocumentEntry]
}

internal enum BundleWireDecoder {
    private static let restToWhereOp: [String: String] = [
        "EQUAL": "==",
        "NOT_EQUAL": "!=",
        "LESS_THAN": "<",
        "LESS_THAN_OR_EQUAL": "<=",
        "GREATER_THAN": ">",
        "GREATER_THAN_OR_EQUAL": ">=",
        "ARRAY_CONTAINS": "array-contains",
        "IN": "in",
        "ARRAY_CONTAINS_ANY": "array-contains-any",
        "NOT_IN": "not-in"
    ]

    static func readStream(_ stream: InputStream) throws -> Data {
        if stream.streamStatus == .notOpen {
            stream.open()
        }
        defer {
            if stream.streamStatus != .closed {
                stream.close()
            }
        }
        var output = Data()
        let chunkSize = 4096
        var buffer = [UInt8](repeating: 0, count: chunkSize)
        while true {
            let bytesRead = buffer.withUnsafeMutableBufferPointer { ptr -> Int in
                guard let base = ptr.baseAddress else { return 0 }
                return stream.read(base, maxLength: chunkSize)
            }
            if bytesRead > 0 {
                output.append(buffer, count: bytesRead)
            } else if bytesRead == 0 {
                break
            } else {
                let errDesc = stream.streamError?.localizedDescription ?? "Failed to read bundle InputStream."
                throw PyricBridgeError.invalidArgument(errDesc)
            }
        }
        return output
    }

    static func decode(_ data: Data) throws -> DecodedFirestoreBundle {
        guard !data.isEmpty else {
            throw PyricBridgeError.invalidArgument("Bundle payload is empty.")
        }
        let bytes = [UInt8](data)
        var rawElements: [(object: [String: Any], endOffset: Int)] = []
        var offset = 0

        while offset < bytes.count {
            var digitEnd = offset
            while digitEnd < bytes.count && bytes[digitEnd] >= 48 && bytes[digitEnd] <= 57 {
                digitEnd += 1
            }
            guard digitEnd > offset else {
                throw PyricBridgeError.invalidArgument("Malformed bundle length prefix.")
            }
            guard let lenStr = String(bytes: bytes[offset..<digitEnd], encoding: .utf8),
                  let elementLen = Int(lenStr),
                  elementLen > 0,
                  digitEnd + elementLen <= bytes.count else {
                throw PyricBridgeError.invalidArgument("Malformed bundle element length.")
            }
            let sliceData = Data(bytes[digitEnd..<(digitEnd + elementLen)])
            let parsedAny: Any
            do {
                parsedAny = try JSONSerialization.jsonObject(with: sliceData)
            } catch {
                throw PyricBridgeError.invalidArgument("Malformed bundle JSON element: \(error.localizedDescription)")
            }
            guard let elementObj = parsedAny as? [String: Any] else {
                throw PyricBridgeError.invalidArgument("Bundle element must be a JSON object.")
            }
            offset = digitEnd + elementLen
            rawElements.append((object: elementObj, endOffset: offset))
        }

        guard let first = rawElements.first,
              let meta = first.object["metadata"] as? [String: Any] else {
            throw PyricBridgeError.invalidArgument("Bundle is missing leading metadata element.")
        }

        let headerBytes = first.endOffset
        var namedQueries: [BundledNamedQuerySpec] = []
        var documents: [BundledDocumentEntry] = []
        var index = 1

        while index < rawElements.count {
            let current = rawElements[index]
            if let namedQueryObj = current.object["namedQuery"] as? [String: Any] {
                namedQueries.append(try parseNamedQuery(namedQueryObj))
                index += 1
            } else if let docMeta = current.object["documentMetadata"] as? [String: Any] {
                let rawName = (docMeta["name"] as? String) ?? ""
                let docPath = relativeDocumentPath(rawName)
                try validateDocumentPath(docPath)
                let exists = (docMeta["exists"] as? Bool) ?? false
                if exists {
                    guard index + 1 < rawElements.count,
                          let docObj = rawElements[index + 1].object["document"] as? [String: Any] else {
                        throw PyricBridgeError.invalidArgument("Missing document payload for '\(docPath)'.")
                    }
                    let rawFields = (docObj["fields"] as? [String: Any]) ?? [:]
                    let encodedFields = try decodeRestFieldsToWire(rawFields)
                    let loadedBytes = rawElements[index + 1].endOffset - headerBytes
                    documents.append(
                        BundledDocumentEntry(
                            docPath: docPath,
                            exists: true,
                            encodedFields: encodedFields,
                            bytesLoadedAfterDoc: loadedBytes
                        )
                    )
                    index += 2
                } else {
                    let loadedBytes = current.endOffset - headerBytes
                    documents.append(
                        BundledDocumentEntry(
                            docPath: docPath,
                            exists: false,
                            encodedFields: nil,
                            bytesLoadedAfterDoc: loadedBytes
                        )
                    )
                    index += 1
                }
            } else {
                throw PyricBridgeError.invalidArgument("Unexpected bundle element.")
            }
        }

        let bundleId = (meta["id"] as? String) ?? "bundle"
        let declaredDocs = intFromJson(meta["totalDocuments"]) ?? documents.count
        let declaredBytes = intFromJson(meta["totalBytes"]) ?? (offset - headerBytes)
        return DecodedFirestoreBundle(
            id: bundleId,
            totalDocuments: declaredDocs,
            totalBytes: declaredBytes,
            namedQueries: namedQueries,
            documents: documents
        )
    }

    private static func relativeDocumentPath(_ resourceName: String) -> String {
        if let range = resourceName.range(of: "/documents/") {
            return String(resourceName[range.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        return resourceName.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private static func validateDocumentPath(_ path: String) throws {
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !path.isEmpty, segments.count % 2 == 0, !segments.contains(where: \.isEmpty) else {
            throw PyricBridgeError.invalidArgument("Invalid bundled document path '\(path)'.")
        }
    }

    private static func intFromJson(_ raw: Any?) -> Int? {
        if let num = raw as? NSNumber, !NSNumberInspector.isBoolean(num) {
            return num.intValue
        }
        if let str = raw as? String, let parsed = Int(str) {
            return parsed
        }
        return nil
    }

    private static func decodeRestFieldsToWire(_ fields: [String: Any]) throws -> [String: AnySendable] {
        var out: [String: AnySendable] = [:]
        for (key, rawVal) in fields {
            guard let valObj = rawVal as? [String: Any] else {
                throw PyricBridgeError.invalidArgument("Malformed REST field value for '\(key)'.")
            }
            out[key] = try decodeRestValueToWire(valObj)
        }
        return out
    }

    private static func decodeRestValueToWire(_ raw: [String: Any]) throws -> AnySendable {
        if raw.keys.contains("nullValue") {
            return .null
        }
        if let num = raw["booleanValue"] as? NSNumber, NSNumberInspector.isBoolean(num) {
            return .bool(num.boolValue)
        }
        if let b = raw["booleanValue"] as? Bool {
            return .bool(b)
        }
        if let s = raw["stringValue"] as? String {
            return .string(s)
        }
        if let intStr = raw["integerValue"] as? String, let parsed = Int64(intStr) {
            return .int(parsed)
        }
        if let intNum = raw["integerValue"] as? NSNumber, !NSNumberInspector.isBoolean(intNum) {
            return .int(intNum.int64Value)
        }
        if let dblStr = raw["doubleValue"] as? String {
            switch dblStr {
            case "NaN", "Infinity", "-Infinity", "-0":
                return .dictionary(["__type": .string("number"), "value": .string(dblStr)])
            default:
                if let parsed = Double(dblStr) {
                    return .double(parsed)
                }
            }
        }
        if let dblNum = raw["doubleValue"] as? NSNumber, !NSNumberInspector.isBoolean(dblNum) {
            return .double(dblNum.doubleValue)
        }
        if let tsStr = raw["timestampValue"] as? String {
            let ts = try parseIsoTimestamp(tsStr)
            return .dictionary([
                "__type": .string("timestamp"),
                "seconds": .int(ts.seconds),
                "nanos": .int(Int64(ts.nanoseconds))
            ])
        }
        if let tsObj = raw["timestampValue"] as? [String: Any] {
            let seconds = (tsObj["seconds"] as? NSNumber)?.int64Value
                ?? (tsObj["seconds"] as? String).flatMap(Int64.init) ?? 0
            let nanos = (tsObj["nanos"] as? NSNumber)?.int64Value ?? 0
            return .dictionary([
                "__type": .string("timestamp"),
                "seconds": .int(seconds),
                "nanos": .int(nanos)
            ])
        }
        if let b64 = raw["bytesValue"] as? String {
            let decodedData = Base64Codec.base64StdDecode(b64) ?? Base64Codec.base64UrlDecodeUnpadded(b64) ?? Data()
            return .dictionary([
                "__type": .string("bytes"),
                "base64": .string(Base64Codec.base64UrlEncodeUnpadded(decodedData))
            ])
        }
        if let gp = raw["geoPointValue"] as? [String: Any] {
            let lat = (gp["latitude"] as? NSNumber)?.doubleValue ?? 0.0
            let lng = (gp["longitude"] as? NSNumber)?.doubleValue ?? 0.0
            return .dictionary([
                "__type": .string("latlng"),
                "lat": .double(lat),
                "lng": .double(lng)
            ])
        }
        if let refStr = raw["referenceValue"] as? String {
            return .dictionary([
                "__type": .string("reference"),
                "path": .string(relativeDocumentPath(refStr))
            ])
        }
        if let arrObj = raw["arrayValue"] as? [String: Any] {
            let rawItems = (arrObj["values"] as? [Any]) ?? []
            var items: [AnySendable] = []
            items.reserveCapacity(rawItems.count)
            for item in rawItems {
                guard let itemDict = item as? [String: Any] else {
                    throw PyricBridgeError.invalidArgument("Malformed arrayValue element in bundle.")
                }
                items.append(try decodeRestValueToWire(itemDict))
            }
            return .array(items)
        }
        if let mapObj = raw["mapValue"] as? [String: Any] {
            let rawFields = (mapObj["fields"] as? [String: Any]) ?? [:]
            let fields = try decodeRestFieldsToWire(rawFields)
            return .dictionary(fields)
        }
        return .null
    }

    private static func parseIsoTimestamp(_ iso: String) throws -> Timestamp {
        let trimmed = iso.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasSuffix("Z") else {
            let formatter = ISO8601DateFormatter()
            if let date = formatter.date(from: trimmed) {
                return Timestamp(date: date)
            }
            throw PyricBridgeError.invalidArgument("Invalid bundled timestamp '\(iso)'.")
        }
        let withoutZ = String(trimmed.dropLast())
        let parts = withoutZ.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        let baseStr = String(parts[0]) + "Z"
        let formatter = ISO8601DateFormatter()
        guard let baseDate = formatter.date(from: baseStr) else {
            throw PyricBridgeError.invalidArgument("Invalid bundled timestamp '\(iso)'.")
        }
        let wholeSeconds = Int64(floor(baseDate.timeIntervalSince1970))
        var nanos: Int32 = 0
        if parts.count == 2 {
            let fracDigits = String(parts[1].prefix(9))
            let padded = fracDigits + String(repeating: "0", count: max(0, 9 - fracDigits.count))
            nanos = Int32(padded) ?? 0
        }
        return Timestamp(seconds: wholeSeconds, nanoseconds: nanos)
    }

    private static func parseNamedQuery(_ nq: [String: Any]) throws -> BundledNamedQuerySpec {
        let queryName = (nq["name"] as? String) ?? ""
        let bq = (nq["bundledQuery"] as? [String: Any]) ?? [:]
        let sq = (bq["structuredQuery"] as? [String: Any]) ?? [:]
        let fromList = (sq["from"] as? [[String: Any]]) ?? []
        let from0 = fromList.first ?? [:]
        let rawParent = (bq["parent"] as? String) ?? ""
        let parentRel: String
        if let range = rawParent.range(of: "/documents/") {
            parentRel = String(rawParent[range.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        } else {
            parentRel = ""
        }
        let collId = (from0["collectionId"] as? String) ?? ""
        let isGroup = (from0["allDescendants"] as? Bool) ?? false
        let collectionPath = (!isGroup && !parentRel.isEmpty) ? "\(parentRel)/\(collId)" : collId

        var constraints: [QueryConstraintDescriptor] = []
        if let whereObj = sq["where"] as? [String: Any],
           let filterConstraint = try parseStructuredFilter(whereObj) {
            constraints.append(filterConstraint)
        }
        if let rawOrders = sq["orderBy"] as? [[String: Any]] {
            for orderItem in rawOrders {
                let fieldObj = orderItem["field"] as? [String: Any]
                let fieldPath = (fieldObj?["fieldPath"] as? String) ?? "__name__"
                let dirRaw = (orderItem["direction"] as? String) ?? "ASCENDING"
                let dir: String? = (dirRaw == "DESCENDING") ? "desc" : nil
                constraints.append(.orderBy(field: fieldPath, direction: dir))
            }
        }
        let limitVal: Int? = intFromJson(sq["limit"])
            ?? (sq["limit"] as? [String: Any]).flatMap { intFromJson($0["value"]) }
        if let limitVal, limitVal > 0 {
            let limitType = (bq["limitType"] as? String) ?? "FIRST"
            if limitType == "LAST" {
                constraints.append(.limitToLast(n: limitVal))
            } else {
                constraints.append(.limit(n: limitVal))
            }
        }

        return BundledNamedQuerySpec(
            name: queryName,
            collectionPath: collectionPath,
            isCollectionGroup: isGroup,
            constraints: constraints
        )
    }

    private static func parseStructuredFilter(_ node: [String: Any]) throws -> QueryConstraintDescriptor? {
        if let ff = node["fieldFilter"] as? [String: Any] {
            let fieldObj = ff["field"] as? [String: Any]
            let fieldPath = (fieldObj?["fieldPath"] as? String) ?? ""
            let rawOp = (ff["op"] as? String) ?? "EQUAL"
            let mappedOp = restToWhereOp[rawOp] ?? "=="
            let rawVal = (ff["value"] as? [String: Any]) ?? [:]
            let wireVal = try decodeRestValueToWire(rawVal)
            return .where(field: fieldPath, op: mappedOp, value: wireVal)
        }
        if let cf = node["compositeFilter"] as? [String: Any] {
            let rawSub = (cf["filters"] as? [[String: Any]]) ?? []
            let sub = try rawSub.compactMap { try parseStructuredFilter($0) }
            let op = (cf["op"] as? String) ?? "AND"
            if op == "OR" {
                return .or(sub)
            }
            return .and(sub)
        }
        return nil
    }
}
