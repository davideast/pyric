import Foundation

// ─── Write & Transaction Descriptors ─────────────────────────────────────────

public enum WriteDescriptor: Sendable, Equatable {
    case set(path: String, data: AnySendable, options: SetOptionsWire? = nil)
    case update(path: String, data: AnySendable)
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
        case .delete(let path):
            return .dictionary([
                "method": .string("delete"),
                "path": .string(path)
            ])
        }
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
            "data": data != nil ? .dictionary(["json": .string(data!.json)]) : .null
        ])
    }
}

public struct SerializedDocData: Sendable, Equatable {
    public let json: String
    public init(json: String) { self.json = json }
}
