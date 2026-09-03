import Foundation

// ─── Dynamic JSON Type-Eraser ────────────────────────────────────────────────

public enum AnySendable: Sendable, Equatable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([AnySendable])
    case dictionary([String: AnySendable])

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    public var intValue: Int64? {
        if case .int(let i) = self { return i }
        return nil
    }

    public var doubleValue: Double? {
        if case .double(let d) = self { return d }
        if case .int(let i) = self { return Double(i) }
        return nil
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var arrayValue: [AnySendable]? {
        if case .array(let a) = self { return a }
        return nil
    }

    public var dictionaryValue: [String: AnySendable]? {
        if case .dictionary(let d) = self { return d }
        return nil
    }

    public subscript(key: String) -> AnySendable? {
        get {
            if case .dictionary(let d) = self { return d[key] }
            return nil
        }
        set {
            if case .dictionary(var d) = self {
                d[key] = newValue
                self = .dictionary(d)
            }
        }
    }

    public subscript(index: Int) -> AnySendable? {
        get {
            if case .array(let a) = self, index >= 0, index < a.count { return a[index] }
            return nil
        }
        set {
            if case .array(var a) = self, index >= 0, index < a.count, let newValue {
                a[index] = newValue
                self = .array(a)
            }
        }
    }

    public func toAny() -> Any? {
        switch self {
        case .null:
            return nil
        case .bool(let b):
            return b
        case .int(let i):
            return i
        case .double(let d):
            return d
        case .string(let s):
            return s
        case .array(let a):
            return a.map { $0.toAny() ?? NSNull() }
        case .dictionary(let d):
            var dict: [String: Any] = [:]
            for (k, v) in d {
                dict[k] = v.toAny() ?? NSNull()
            }
            return dict
        }
    }

    public static func from(_ any: Any?) -> AnySendable {
        guard let any = any, !(any is NSNull) else {
            return .null
        }

        if let sendable = any as? AnySendable {
            return sendable
        }

        if let b = any as? Bool {
            return .bool(b)
        }

        if let num = any as? NSNumber {
            if CFGetTypeID(num) == CFBooleanGetTypeID() {
                return .bool(num.boolValue)
            }
            if CFNumberIsFloatType(num as CFNumber) {
                return .double(num.doubleValue)
            }
            return .int(num.int64Value)
        }

        if let i = any as? Int { return .int(Int64(i)) }
        if let i64 = any as? Int64 { return .int(i64) }
        if let i32 = any as? Int32 { return .int(Int64(i32)) }
        if let d = any as? Double { return .double(d) }
        if let f = any as? Float { return .double(Double(f)) }
        if let s = any as? String { return .string(s) }

        if let arr = any as? [Any] {
            return .array(arr.map { AnySendable.from($0) })
        }

        if let dict = any as? [String: Any] {
            var res: [String: AnySendable] = [:]
            for (k, v) in dict {
                res[k] = AnySendable.from(v)
            }
            return .dictionary(res)
        }

        return .string(String(describing: any))
    }
}

extension AnySendable: ExpressibleByNilLiteral {
    public init(nilLiteral: ()) {
        self = .null
    }
}

extension AnySendable: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) {
        self = .bool(value)
    }
}

extension AnySendable: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int64) {
        self = .int(value)
    }
}

extension AnySendable: ExpressibleByFloatLiteral {
    public init(floatLiteral value: Double) {
        self = .double(value)
    }
}

extension AnySendable: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) {
        self = .string(value)
    }
}

extension AnySendable: ExpressibleByArrayLiteral {
    public init(arrayLiteral elements: AnySendable...) {
        self = .array(elements)
    }
}

extension AnySendable: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, AnySendable)...) {
        var dict: [String: AnySendable] = [:]
        for (k, v) in elements {
            dict[k] = v
        }
        self = .dictionary(dict)
    }
}

extension AnySendable: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let i = try? container.decode(Int64.self) {
            self = .int(i)
        } else if let d = try? container.decode(Double.self) {
            self = .double(d)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([AnySendable].self) {
            self = .array(a)
        } else if let d = try? container.decode([String: AnySendable].self) {
            self = .dictionary(d)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unable to decode AnySendable")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let b):
            try container.encode(b)
        case .int(let i):
            try container.encode(i)
        case .double(let d):
            try container.encode(d)
        case .string(let s):
            try container.encode(s)
        case .array(let a):
            try container.encode(a)
        case .dictionary(let d):
            try container.encode(d)
        }
    }
}

extension AnySendable: CustomStringConvertible {
    public var description: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .int(let i): return "\(i)"
        case .double(let d): return "\(d)"
        case .string(let s): return "\"\(s)\""
        case .array(let a): return "[\(a.map(\.description).joined(separator: ", "))]"
        case .dictionary(let d):
            let entries = d.map { "\"\($0.key)\": \($0.value.description)" }.joined(separator: ", ")
            return "{\(entries)}"
        }
    }
}

// ─── Wire Frames ─────────────────────────────────────────────────────────────

public struct AttachFrame: Codable, Sendable {
    public let type: String = "attach"
    public let protocolVersion: Int = 1

    enum CodingKeys: String, CodingKey {
        case type
        case protocolVersion = "protocol"
    }

    public init() {}
}

public struct AttachAckFrame: Codable, Sendable {
    public let type: String
    public let protocolVersion: Int?
    public let bridgeVersion: String?
    public let peerConnected: Bool
    public let serveVersion: String?

    enum CodingKeys: String, CodingKey {
        case type
        case protocolVersion = "protocol"
        case bridgeVersion
        case peerConnected
        case serveVersion
    }

    public init(
        type: String = "attach-ack",
        protocolVersion: Int? = 1,
        bridgeVersion: String? = nil,
        peerConnected: Bool = true,
        serveVersion: String? = nil
    ) {
        self.type = type
        self.protocolVersion = protocolVersion
        self.bridgeVersion = bridgeVersion
        self.peerConnected = peerConnected
        self.serveVersion = serveVersion
    }
}

public struct WorkerOpFrame: Codable, Sendable {
    public let type: String
    public let id: String
    public let op: [String: AnySendable]

    public init(id: String, op: [String: AnySendable]) {
        self.type = "worker-op"
        self.id = id
        self.op = op
    }
}

public struct WorkerResFrame: Codable, Sendable {
    public let type: String
    public let id: String
    public let ok: Bool
    public let value: AnySendable?
    public let error: BridgeErrorPayload?

    public init(
        type: String = "worker-res",
        id: String,
        ok: Bool,
        value: AnySendable? = nil,
        error: BridgeErrorPayload? = nil
    ) {
        self.type = type
        self.id = id
        self.ok = ok
        self.value = value
        self.error = error
    }
}

public struct BridgeErrorPayload: Codable, Sendable {
    public let code: String
    public let message: String
    public let denialContext: AnySendable?
    public let envelope: AnySendable?

    public init(
        code: String,
        message: String,
        denialContext: AnySendable? = nil,
        envelope: AnySendable? = nil
    ) {
        self.code = code
        self.message = message
        self.denialContext = denialContext
        self.envelope = envelope
    }
}

public struct WorkerSubFrame: Codable, Sendable {
    public let type: String
    public let subId: String
    public let sub: [String: AnySendable]

    public init(subId: String, sub: [String: AnySendable]) {
        self.type = "worker-sub"
        self.subId = subId
        self.sub = sub
    }
}

public struct WorkerUnsubFrame: Codable, Sendable {
    public let type: String
    public let subId: String

    public init(subId: String) {
        self.type = "worker-unsub"
        self.subId = subId
    }
}

public struct WorkerSnapFrame: Codable, Sendable {
    public let type: String
    public let subId: String
    public let value: AnySendable

    public init(type: String = "worker-snap", subId: String, value: AnySendable) {
        self.type = type
        self.subId = subId
        self.value = value
    }
}

public struct PingFrame: Codable, Sendable {
    public let type: String
    public let id: String

    public init(id: String) {
        self.type = "ping"
        self.id = id
    }
}

public struct PongFrame: Codable, Sendable {
    public let type: String
    public let id: String

    public init(id: String) {
        self.type = "pong"
        self.id = id
    }
}

// ─── Descriptors & Target Types ──────────────────────────────────────────────

public enum TargetDescriptor: Sendable, Equatable {
    case doc(path: String)
    case collection(path: String)
    case group(collectionId: String)
    case query(source: Box<TargetDescriptor>, constraints: [QueryConstraintDescriptor])

    public final class Box<T: Sendable & Equatable>: Sendable, Equatable {
        public let value: T
        public init(_ value: T) { self.value = value }
        public static func == (lhs: Box<T>, rhs: Box<T>) -> Bool { lhs.value == rhs.value }
    }

    public func toAnySendable() -> AnySendable {
        switch self {
        case .doc(let path):
            return .dictionary([
                "__ref": .string("doc"),
                "path": .string(path)
            ])
        case .collection(let path):
            return .dictionary([
                "__ref": .string("collection"),
                "path": .string(path)
            ])
        case .group(let collectionId):
            return .dictionary([
                "__ref": .string("group"),
                "collectionId": .string(collectionId)
            ])
        case .query(let sourceBox, let constraints):
            return .dictionary([
                "__ref": .string("query"),
                "source": sourceBox.value.toAnySendable(),
                "constraints": .array(constraints.map { $0.toAnySendable() })
            ])
        }
    }
}

public enum QueryConstraintDescriptor: Sendable, Equatable {
    case `where`(field: String, op: String, value: AnySendable)
    case and([QueryConstraintDescriptor])
    case or([QueryConstraintDescriptor])
    case orderBy(field: String, direction: String?)
    case limit(n: Int)
    case limitToLast(n: Int)
    case startAt(values: [AnySendable])
    case startAfter(values: [AnySendable])
    case endAt(values: [AnySendable])
    case endBefore(values: [AnySendable])

    public func toAnySendable() -> AnySendable {
        switch self {
        case .where(let field, let op, let value):
            return .dictionary([
                "kind": .string("where"),
                "field": .string(field),
                "op": .string(op),
                "value": value
            ])
        case .and(let filters):
            return .dictionary([
                "kind": .string("and"),
                "filters": .array(filters.map { $0.toAnySendable() })
            ])
        case .or(let filters):
            return .dictionary([
                "kind": .string("or"),
                "filters": .array(filters.map { $0.toAnySendable() })
            ])
        case .orderBy(let field, let direction):
            var dict: [String: AnySendable] = [
                "kind": .string("orderBy"),
                "field": .string(field)
            ]
            if let direction { dict["direction"] = .string(direction) }
            return .dictionary(dict)
        case .limit(let n):
            return .dictionary([
                "kind": .string("limit"),
                "n": .int(Int64(n))
            ])
        case .limitToLast(let n):
            return .dictionary([
                "kind": .string("limitToLast"),
                "n": .int(Int64(n))
            ])
        case .startAt(let values):
            return .dictionary([
                "kind": .string("startAt"),
                "values": .array(values)
            ])
        case .startAfter(let values):
            return .dictionary([
                "kind": .string("startAfter"),
                "values": .array(values)
            ])
        case .endAt(let values):
            return .dictionary([
                "kind": .string("endAt"),
                "values": .array(values)
            ])
        case .endBefore(let values):
            return .dictionary([
                "kind": .string("endBefore"),
                "values": .array(values)
            ])
        }
    }
}

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

public enum AuthLens: Sendable, Equatable, ExpressibleByDictionaryLiteral {
    case appSession
    case admin
    case asUser(uid: String)
    case anon
    case custom([String: AnySendable])

    public init(dictionaryLiteral elements: (String, AnySendable)...) {
        var dict: [String: AnySendable] = [:]
        for (k, v) in elements {
            dict[k] = v
        }
        if dict["mode"]?.stringValue == "admin" {
            self = .admin
        } else if dict["mode"]?.stringValue == "anon" {
            self = .anon
        } else if dict["mode"]?.stringValue == "as", let uid = dict["uid"]?.stringValue {
            self = .asUser(uid: uid)
        } else if dict["mode"]?.stringValue == "app-session" {
            self = .appSession
        } else {
            self = .custom(dict)
        }
    }

    public func toAnySendable() -> AnySendable {
        switch self {
        case .appSession:
            return .dictionary(["mode": .string("app-session")])
        case .admin:
            return .dictionary(["mode": .string("admin")])
        case .asUser(let uid):
            return .dictionary(["mode": .string("as"), "uid": .string(uid)])
        case .anon:
            return .dictionary(["mode": .string("anon")])
        case .custom(let dict):
            return .dictionary(dict)
        }
    }
}

public enum AggregateFieldDescriptor: Sendable, Equatable {
    case count
    case sum(field: String)
    case average(field: String)

    public func toAnySendable() -> AnySendable {
        switch self {
        case .count:
            return .dictionary(["kind": .string("count")])
        case .sum(let field):
            return .dictionary(["kind": .string("sum"), "field": .string(field)])
        case .average(let field):
            return .dictionary(["kind": .string("average"), "field": .string(field)])
        }
    }
}
