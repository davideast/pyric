import Foundation

// --- Write & Transaction Descriptors ---

public struct UpdateFieldWire: Sendable, Equatable {
    public let path: [String]
    public let value: AnySendable

    public init(path: [String], value: AnySendable) {
        self.path = path
        self.value = value
    }

    public func toAnySendable() -> AnySendable {
        .dictionary([
            "path": .array(path.map { .string($0) }),
            "value": value
        ])
    }
}

public enum WriteDescriptor: Sendable, Equatable {
    case set(path: String, data: AnySendable, options: SetOptionsWire? = nil)
    case update(path: String, data: AnySendable)
    case updateFields(path: String, fields: [UpdateFieldWire])
    case delete(path: String)

    public func toAnySendable() -> AnySendable {
        switch self {
        case .set(let path, let data, let options):
            var dict: [String: AnySendable] = [
                "method": .string("set"),
                "path": .string(path),
                "data": data
            ]
            if let options { dict["options"] = options.toAnySendable() }
            return .dictionary(dict)
        case .update(let path, let data):
            return .dictionary([
                "method": .string("update"),
                "path": .string(path),
                "data": data
            ])
        case .updateFields(let path, let fields):
            return .dictionary([
                "method": .string("update"),
                "path": .string(path),
                "fields": .array(fields.map { $0.toAnySendable() })
            ])
        case .delete(let path):
            return .dictionary([
                "method": .string("delete"),
                "path": .string(path)
            ])
        }
    }

    internal func toOfflineMutation() -> OfflineWriteMutation {
        switch self {
        case .set(let path, let data, let options):
            if let mergeFields = options?.mergeFields {
                return .set(
                    path: path,
                    encodedData: data.dictionaryValue ?? [:],
                    merge: false,
                    mergeFields: mergeFields
                )
            }
            return .set(
                path: path,
                encodedData: data.dictionaryValue ?? [:],
                merge: options?.merge ?? false,
                mergeFields: nil
            )
        case .update(let path, let data):
            return .update(path: path, encodedFields: data.dictionaryValue ?? [:])
        case .updateFields(let path, let fields):
            return .updateSegments(
                path: path,
                entries: fields.map { UpdateSegmentEntry(segments: $0.path, value: $0.value) }
            )
        case .delete(let path):
            return .delete(path: path)
        }
    }

    internal static func validateAndEncodeMergeFields(
        data: [String: Any],
        mergeFields: [Any]
    ) throws -> [String] {
        var wireKeys: [String] = []
        wireKeys.reserveCapacity(mergeFields.count)
        for item in mergeFields {
            let segments: [String]
            if let str = item as? String {
                segments = FirestoreOfflineProjection.splitFieldPath(str)
                if str.isEmpty || segments.contains(where: \.isEmpty) {
                    throw PyricFirestoreError.invalidArgument("Invalid field path '\(str)' in mergeFields.")
                }
            } else if let fp = item as? FieldPath {
                segments = fp.segments
            } else {
                throw PyricFirestoreError.invalidArgument("mergeFields elements must be String or FieldPath")
            }

            var current: Any? = data
            for seg in segments {
                guard let dict = current as? [String: Any], let nextVal = dict[seg] else {
                    throw PyricFirestoreError.invalidArgument(
                        "Field '\(segments.joined(separator: "."))' specified in mergeFields was not provided in data."
                    )
                }
                current = nextVal
            }
            wireKeys.append(FirestoreOfflineProjection.encodeFieldPathKey(segments))
        }
        return wireKeys
    }

    internal static func prepareAtomicUpdate(
        path: String,
        fields: [AnyHashable: Any]
    ) throws -> WriteDescriptor {
        let needsSegmentForm = fields.keys.contains { key in
            guard let fp = key as? FieldPath else { return false }
            return fp.segments.contains { $0.contains(".") || $0.contains("`") || $0.contains("\\") }
        }
        if needsSegmentForm {
            var keyedEntries: [(sortKey: String, entry: UpdateFieldWire)] = []
            keyedEntries.reserveCapacity(fields.count)
            for (key, val) in fields {
                let segments: [String]
                if let str = key as? String {
                    segments = FirestoreOfflineProjection.splitFieldPath(str)
                    if str.isEmpty || segments.contains(where: \.isEmpty) {
                        throw PyricFirestoreError.invalidArgument("Invalid updateData field path '\(str)'.")
                    }
                } else if let fp = key as? FieldPath {
                    segments = fp.segments
                } else {
                    throw PyricFirestoreError.invalidArgument("updateData keys must be String or FieldPath")
                }
                let encodedVal = AnySendable.from(try ValueCodec.encodeValue(val))
                keyedEntries.append((
                    sortKey: FirestoreOfflineProjection.encodeFieldPathKey(segments),
                    entry: UpdateFieldWire(path: segments, value: encodedVal)
                ))
            }
            keyedEntries.sort { $0.sortKey < $1.sortKey }
            return .updateFields(path: path, fields: keyedEntries.map(\.entry))
        }

        var stringDict: [String: Any] = [:]
        for (key, val) in fields {
            if let str = key as? String {
                let parts = str.split(separator: ".", omittingEmptySubsequences: false)
                if str.isEmpty || parts.contains(where: \.isEmpty) {
                    throw PyricFirestoreError.invalidArgument("Invalid updateData field path '\(str)'.")
                }
                stringDict[str] = val
            } else if let fp = key as? FieldPath {
                stringDict[fp.stringRepresentation] = val
            } else {
                throw PyricFirestoreError.invalidArgument("updateData keys must be String or FieldPath")
            }
        }
        let encoded = try ValueCodec.encodeWriteData(stringDict)
        return .update(path: path, data: AnySendable.from(encoded))
    }
}

public struct SetOptionsWire: Sendable, Equatable {
    public let merge: Bool?
    public let mergeFields: [String]?

    public init(merge: Bool? = nil, mergeFields: [String]? = nil) {
        self.merge = merge
        self.mergeFields = mergeFields
    }

    public func toAnySendable() -> AnySendable {
        var dict: [String: AnySendable] = [:]
        if let merge { dict["merge"] = .bool(merge) }
        if let mergeFields { dict["mergeFields"] = .array(mergeFields.map { .string($0) }) }
        return .dictionary(dict)
    }
}

public struct TxnReadEntry: Sendable, Equatable {
    public let path: String
    public let data: SerializedDocData?

    public init(path: String, data: SerializedDocData?) {
        self.path = path
        self.data = data
    }

    public func toAnySendable() -> AnySendable {
        return .dictionary([
            "path": .string(path),
            "data": data?.toAnySendable() ?? .null
        ])
    }
}

public struct SerializedDocData: Sendable, Equatable {
    public let json: String
    public let valueEncoding: String?

    public init(json: String, valueEncoding: String? = nil) {
        self.json = json
        self.valueEncoding = valueEncoding
    }

    public func toAnySendable() -> AnySendable {
        var dict: [String: AnySendable] = ["json": .string(json)]
        if let valueEncoding {
            dict["valueEncoding"] = .string(valueEncoding)
        }
        return .dictionary(dict)
    }
}
