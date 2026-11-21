import Foundation
import PyricFirestore

/// A collection of name-value pairs representing a JSON object.
public typealias JSONObject = [String: JSONValue]

/// Represents a value in one of JSON's data types (`google.protobuf.Value`).
public enum JSONValue: Sendable, Equatable {
    case null
    case number(Double)
    case string(String)
    case bool(Bool)
    case object(JSONObject)
    case array([JSONValue])

    public var stringValue: String? {
        if case .string(let v) = self { return v }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let v) = self { return v }
        return nil
    }

    public var intValue: Int? {
        if case .number(let v) = self, v.isFinite {
            return Int(exactly: v.rounded(.towardZero))
        }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let v) = self { return v }
        return nil
    }

    public var objectValue: JSONObject? {
        if case .object(let v) = self { return v }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let v) = self { return v }
        return nil
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let dict) = self { return dict[key] }
        return nil
    }
}

extension JSONValue: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let boolVal = try? container.decode(Bool.self) {
            self = .bool(boolVal)
        } else if let numberVal = try? container.decode(Double.self) {
            self = .number(numberVal)
        } else if let stringVal = try? container.decode(String.self) {
            self = .string(stringVal)
        } else if let objectVal = try? container.decode(JSONObject.self) {
            self = .object(objectVal)
        } else if let arrayVal = try? container.decode([JSONValue].self) {
            self = .array(arrayVal)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Failed to decode JSONValue."
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .number(let numberVal):
            if numberVal.isFinite,
               !(numberVal == 0.0 && numberVal.sign == .minus),
               numberVal.truncatingRemainder(dividingBy: 1.0) == 0.0,
               numberVal >= Double(Int64.min),
               numberVal < 9_223_372_036_854_775_807.0,
               let exactInt = Int64(exactly: numberVal) {
                try container.encode(exactInt)
            } else {
                try container.encode(numberVal)
            }
        case .string(let stringVal):
            try container.encode(stringVal)
        case .bool(let boolVal):
            try container.encode(boolVal)
        case .object(let objectVal):
            try container.encode(objectVal)
        case .array(let arrayVal):
            try container.encode(arrayVal)
        }
    }
}

extension JSONValue: ExpressibleByNilLiteral,
    ExpressibleByBooleanLiteral,
    ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral,
    ExpressibleByStringLiteral,
    ExpressibleByArrayLiteral,
    ExpressibleByDictionaryLiteral {
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        var out: JSONObject = [:]
        for (k, v) in elements {
            out[k] = v
        }
        self = .object(out)
    }
}

extension JSONValue {
    package init(anySendable: AnySendable) {
        switch anySendable {
        case .null:
            self = .null
        case .bool(let b):
            self = .bool(b)
        case .int(let i):
            self = .number(Double(i))
        case .double(let d):
            self = .number(d)
        case .string(let s):
            self = .string(s)
        case .array(let arr):
            self = .array(arr.map(JSONValue.init(anySendable:)))
        case .dictionary(let dict):
            self = .object(dict.mapValues(JSONValue.init(anySendable:)))
        }
    }

    package func toAnySendable() -> AnySendable {
        switch self {
        case .null:
            return .null
        case .bool(let b):
            return .bool(b)
        case .number(let n):
            if n.isFinite,
               !(n == 0.0 && n.sign == .minus),
               n.truncatingRemainder(dividingBy: 1.0) == 0.0,
               n >= Double(Int64.min),
               n < 9_223_372_036_854_775_807.0,
               let exactInt = Int64(exactly: n) {
                return .int(exactInt)
            }
            return .double(n)
        case .string(let s):
            return .string(s)
        case .array(let arr):
            return .array(arr.map { $0.toAnySendable() })
        case .object(let dict):
            return .dictionary(dict.mapValues { $0.toAnySendable() })
        }
    }
}

extension PyricAIEngineConfig {
    package func toAnySendable() -> AnySendable {
        switch self {
        case .scripted(let script):
            var dict: [String: AnySendable] = ["kind": .string("scripted")]
            if let script {
                dict["script"] = .array(script.map { entry in
                    .dictionary(entry.mapValues { $0.toAnySendable() })
                })
            }
            return .dictionary(dict)
        case .openai(let baseUrl, let model, let modelMap):
            var dict: [String: AnySendable] = ["kind": .string("openai")]
            if let baseUrl { dict["baseUrl"] = .string(baseUrl) }
            if let model { dict["model"] = .string(model) }
            if let modelMap {
                dict["modelMap"] = .dictionary(modelMap.mapValues { .string($0) })
            }
            return .dictionary(dict)
        case .gemini(let baseUrl, let apiKey):
            var dict: [String: AnySendable] = ["kind": .string("gemini")]
            if let baseUrl { dict["baseUrl"] = .string(baseUrl) }
            if let apiKey { dict["apiKey"] = .string(apiKey) }
            return .dictionary(dict)
        }
    }
}
