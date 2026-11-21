import Foundation
import PyricFirestore

/// Wire serializer and deserializer for Cloud Functions callable payloads,
/// matching `FirebaseFunctions` (`13.2.0`) across Apple Darwin and Linux.
public final class FunctionsSerializer: Sendable {
    public static let int64TypeURL = "type.googleapis.com/google.protobuf.Int64Value"
    public static let uint64TypeURL = "type.googleapis.com/google.protobuf.UInt64Value"

    public enum SerializerError: Error, LocalizedError, Sendable, Equatable {
        case unsupportedType(typeName: String)
        case nonFiniteNumber(String)
        case nonStringDictionaryKey(typeName: String)
        case failedToParseWrappedNumber(value: String, type: String)

        public var errorDescription: String? {
            switch self {
            case .unsupportedType(let typeName):
                return "Unsupported callable payload type: \(typeName)"
            case .nonFiniteNumber(let raw):
                return "Callable payload cannot encode non-finite floating-point number: \(raw)"
            case .nonStringDictionaryKey(let typeName):
                return "Callable dictionary keys must be String, got \(typeName)"
            case .failedToParseWrappedNumber(let value, let type):
                return "Failed to parse wrapped integer '\(value)' for @type '\(type)'"
            }
        }
    }

    public init() {}

    /// Encodes a Swift or Foundation value into a JSON-serializable object tree,
    /// wrapping 64-bit signed (`Int`/`Int64`) and unsigned (`UInt`/`UInt64`) integers
    /// in protobuf `Int64Value` / `UInt64Value` envelopes and rejecting non-finite floats.
    public func encode(_ rawValue: Any?) throws -> Any {
        guard let unwrapped = Self.unwrapOptional(rawValue), !(unwrapped is NSNull) else {
            return NSNull()
        }

        if let number = unwrapped as? NSNumber {
            if NSNumberInspector.isBoolean(number) {
                return number.boolValue
            }
            if NSNumberInspector.isFloatingPoint(number) {
                let dbl = number.doubleValue
                guard dbl.isFinite else {
                    throw SerializerError.nonFiniteNumber(String(describing: dbl))
                }
                return dbl
            }
            let cType = String(cString: number.objCType)
            switch cType {
            case "q":
                return [
                    "@type": Self.int64TypeURL,
                    "value": "\(number.int64Value)"
                ]
            case "Q":
                return [
                    "@type": Self.uint64TypeURL,
                    "value": "\(number.uint64Value)"
                ]
            default:
                return Int(number.int64Value)
            }
        }

        if let boolValue = unwrapped as? Bool {
            return boolValue
        }
        if let intValue = unwrapped as? Int {
            return [
                "@type": Self.int64TypeURL,
                "value": "\(intValue)"
            ]
        }
        if let int64Value = unwrapped as? Int64 {
            return [
                "@type": Self.int64TypeURL,
                "value": "\(int64Value)"
            ]
        }
        if let uintValue = unwrapped as? UInt {
            return [
                "@type": Self.uint64TypeURL,
                "value": "\(uintValue)"
            ]
        }
        if let uint64Value = unwrapped as? UInt64 {
            return [
                "@type": Self.uint64TypeURL,
                "value": "\(uint64Value)"
            ]
        }
        if let int32Value = unwrapped as? Int32 {
            return Int(int32Value)
        }
        if let int16Value = unwrapped as? Int16 {
            return Int(int16Value)
        }
        if let int8Value = unwrapped as? Int8 {
            return Int(int8Value)
        }
        if let uint32Value = unwrapped as? UInt32 {
            return Int(uint32Value)
        }
        if let uint16Value = unwrapped as? UInt16 {
            return Int(uint16Value)
        }
        if let uint8Value = unwrapped as? UInt8 {
            return Int(uint8Value)
        }
        if let doubleValue = unwrapped as? Double {
            guard doubleValue.isFinite else {
                throw SerializerError.nonFiniteNumber(String(describing: doubleValue))
            }
            return doubleValue
        }
        if let floatValue = unwrapped as? Float {
            let dbl = Double(floatValue)
            guard dbl.isFinite else {
                throw SerializerError.nonFiniteNumber(String(describing: floatValue))
            }
            return dbl
        }
        if let stringValue = unwrapped as? String {
            return stringValue
        }
        if let nsString = unwrapped as? NSString {
            return String(nsString)
        }
        if let swiftDict = unwrapped as? [String: Any] {
            var result: [String: Any] = [:]
            result.reserveCapacity(swiftDict.count)
            for (key, item) in swiftDict {
                result[key] = try encode(item)
            }
            return result
        }
        if let anyDict = unwrapped as? [AnyHashable: Any] {
            var result: [String: Any] = [:]
            result.reserveCapacity(anyDict.count)
            for (rawKey, item) in anyDict {
                guard let strKey = rawKey.base as? String ?? (rawKey.base as? NSString).map({ String($0) }) else {
                    throw SerializerError.nonStringDictionaryKey(
                        typeName: String(describing: type(of: rawKey.base))
                    )
                }
                result[strKey] = try encode(item)
            }
            return result
        }
        if let nsDict = unwrapped as? NSDictionary {
            var result: [String: Any] = [:]
            result.reserveCapacity(nsDict.count)
            for (rawKey, item) in nsDict {
                guard let strKey = rawKey as? String ?? (rawKey as? NSString).map({ String($0) }) else {
                    throw SerializerError.nonStringDictionaryKey(
                        typeName: String(describing: type(of: rawKey))
                    )
                }
                result[strKey] = try encode(item)
            }
            return result
        }
        if let swiftArray = unwrapped as? [Any] {
            return try swiftArray.map { try encode($0) }
        }
        if let nsArray = unwrapped as? NSArray {
            var result: [Any] = []
            result.reserveCapacity(nsArray.count)
            for idx in 0..<nsArray.count {
                result.append(try encode(nsArray.object(at: idx)))
            }
            return result
        }

        throw SerializerError.unsupportedType(typeName: String(describing: type(of: unwrapped)))
    }

    /// Decodes a JSON object tree returned by a callable response into native Swift values,
    /// unwrapping protobuf `Int64Value` -> `Int` and `UInt64Value` -> `UInt`.
    public func decode(_ rawObject: Any?) throws -> Any {
        guard let unwrapped = Self.unwrapOptional(rawObject), !(unwrapped is NSNull) else {
            return NSNull()
        }

        if let dict = unwrapped as? [String: Any] {
            return try decodeDictionary(dict)
        }
        if let nsDict = unwrapped as? NSDictionary {
            var swiftDict: [String: Any] = [:]
            swiftDict.reserveCapacity(nsDict.count)
            for (rawKey, item) in nsDict {
                if let key = rawKey as? String ?? (rawKey as? NSString).map({ String($0) }) {
                    swiftDict[key] = item
                }
            }
            return try decodeDictionary(swiftDict)
        }
        if let array = unwrapped as? [Any] {
            return try array.map { try decode($0) }
        }
        if let nsArray = unwrapped as? NSArray {
            var result: [Any] = []
            result.reserveCapacity(nsArray.count)
            for idx in 0..<nsArray.count {
                result.append(try decode(nsArray.object(at: idx)))
            }
            return result
        }
        if let number = unwrapped as? NSNumber {
            if NSNumberInspector.isBoolean(number) {
                return number.boolValue
            }
            if NSNumberInspector.isFloatingPoint(number) {
                return number.doubleValue
            }
            return Int(number.int64Value)
        }
        if let boolValue = unwrapped as? Bool {
            return boolValue
        }
        if let intValue = unwrapped as? Int {
            return intValue
        }
        if let int64Value = unwrapped as? Int64 {
            return Int(int64Value)
        }
        if let uintValue = unwrapped as? UInt {
            return uintValue
        }
        if let uint64Value = unwrapped as? UInt64 {
            return UInt(uint64Value)
        }
        if let doubleValue = unwrapped as? Double {
            return doubleValue
        }
        if let stringValue = unwrapped as? String {
            return stringValue
        }
        if let nsString = unwrapped as? NSString {
            return String(nsString)
        }

        throw SerializerError.unsupportedType(typeName: String(describing: type(of: unwrapped)))
    }

    private func decodeDictionary(_ dict: [String: Any]) throws -> Any {
        if let typeURL = dict["@type"] as? String {
            if typeURL == Self.int64TypeURL {
                guard let valueString = dict["value"] as? String,
                      let parsed = Int64(valueString) else {
                    let rawVal = dict["value"].map { String(describing: $0) } ?? "nil"
                    throw SerializerError.failedToParseWrappedNumber(value: rawVal, type: typeURL)
                }
                return Int(parsed)
            }
            if typeURL == Self.uint64TypeURL {
                guard let valueString = dict["value"] as? String,
                      let parsed = UInt64(valueString) else {
                    let rawVal = dict["value"].map { String(describing: $0) } ?? "nil"
                    throw SerializerError.failedToParseWrappedNumber(value: rawVal, type: typeURL)
                }
                return UInt(parsed)
            }
            throw SerializerError.unsupportedType(typeName: typeURL)
        }

        var decoded: [String: Any] = [:]
        decoded.reserveCapacity(dict.count)
        for (key, value) in dict {
            decoded[key] = try decode(value)
        }
        return decoded
    }

    private static func unwrapOptional(_ value: Any?) -> Any? {
        guard let value else {
            return nil
        }
        let mirror = Mirror(reflecting: value)
        guard mirror.displayStyle == .optional else {
            return value
        }
        guard let firstChild = mirror.children.first else {
            return nil
        }
        return unwrapOptional(firstChild.value)
    }
}
