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
