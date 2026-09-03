import Foundation

// ─── Base64 Codec ────────────────────────────────────────────────────────────

public enum Base64Codec {
    public static func base64UrlEncodeUnpadded(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func base64UrlDecodeUnpadded(_ input: String) -> Data? {
        var normalized = input
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = normalized.count % 4
        if remainder > 0 {
            normalized.append(String(repeating: "=", count: 4 - remainder))
        }
        return Data(base64Encoded: normalized)
    }

    public static func base64StdDecode(_ input: String) -> Data? {
        var normalized = input
        let remainder = normalized.count % 4
        if remainder > 0 {
            normalized.append(String(repeating: "=", count: 4 - remainder))
        }
        return Data(base64Encoded: normalized)
    }
}

// ─── Reference Holder & Resolver ────────────────────────────────────────────

public protocol PathReferenceable: Sendable {
    var path: String { get }
}

public struct DocumentReferenceHolder: PathReferenceable, Equatable, Hashable, Sendable, CustomStringConvertible {
    public let path: String

    public init(path: String) {
        self.path = path
    }

    public var description: String {
        "DocumentReferenceHolder(\(path))"
    }
}

public typealias PyricDocumentReferenceHolder = DocumentReferenceHolder
public typealias DocumentReferenceResolver = @Sendable (String) -> Any

// ─── Value Codec ─────────────────────────────────────────────────────────────

public enum ValueCodec {
    private static let sentinelTypes: Set<String> = [
        "serverTimestamp",
        "increment",
        "arrayUnion",
        "arrayRemove",
        "deleteField",
        "delete"
    ]

    // MARK: - Serializer (Swift -> Wire JSON)

    /// Encodes a Swift value into its Pyric wire representation.
    public static func encodeValue(_ value: Any?) throws -> Any {
        guard let value = value, !(value is NSNull) else {
            return NSNull()
        }

        // 1. Numbers and NSNumber booleans (must precede Bool check to prevent bridging 1/0 to Bool)
        if let num = value as? NSNumber {
            if CFGetTypeID(num) == CFBooleanGetTypeID() {
                return num.boolValue
            }
            return num
        }

        // 2. Primitive booleans
        if let boolVal = value as? Bool {
            return boolVal
        }
        if let intVal = value as? Int { return intVal }
        if let int64Val = value as? Int64 { return int64Val }
        if let int32Val = value as? Int32 { return int32Val }
        if let doubleVal = value as? Double { return doubleVal }
        if let floatVal = value as? Float { return Double(floatVal) }

        // 3. Strings
        if let stringVal = value as? String {
            return stringVal
        }

        // 4. Sentinels & FieldValue
        if let fv = value as? FieldValue {
            return try fv.sentinel.toWireSentinel()
        }
        if let sentinel = value as? any PyricSentinel {
            return try sentinel.toWireSentinel()
        }

        // 5. Timestamps & Dates
        if let ts = value as? Timestamp {
            return [
                "__type": "timestamp",
                "seconds": ts.seconds,
                "nanos": ts.nanoseconds
            ]
        }
        if let date = value as? Date {
            let ts = Timestamp(date: date)
            return [
                "__type": "timestamp",
                "seconds": ts.seconds,
                "nanos": ts.nanoseconds
            ]
        }

        // 6. GeoPoint
        if let gp = value as? GeoPoint {
            return [
                "__type": "latlng",
                "lat": gp.latitude,
                "lng": gp.longitude
            ]
        }

        // 7. Binary Data (Blob / Bytes)
        if let data = value as? Data {
            return [
                "__type": "bytes",
                "base64": Base64Codec.base64UrlEncodeUnpadded(data)
            ]
        }

        // 8. Document References
        if let ref = value as? PathReferenceable {
            return [
                "__type": "reference",
                "path": ref.path
            ]
        }

        // 9. Vector Value
        if let vec = value as? VectorValue {
            return [
                "__sentinel": "vector",
                "values": vec.values
            ]
        }

        // 10. Arrays
        if let array = value as? [Any] {
            return try array.map { try encodeValue($0) }
        }

        // 11. Dictionaries & Maps
        if let dict = value as? [String: Any] {
            // (a) Direct __sentinel envelope
            if let sentinel = dict["__sentinel"] as? String {
                if sentinel == "serverTimestamp" || sentinel == "deleteField" {
                    return ["__sentinel": sentinel]
                }
                if sentinel == "increment" {
                    return ["__sentinel": "increment", "n": dict["n"] as Any]
                }
                if sentinel == "arrayUnion" || sentinel == "arrayRemove" {
                    let raw = (dict["values"] as? [Any]) ?? []
                    return [
                        "__sentinel": sentinel,
                        "values": try raw.map { try encodeValue($0) }
                    ]
                }
                if sentinel == "vector" {
                    return ["__sentinel": "vector", "values": dict["values"] as Any]
                }
            }

            // (b) Transmutation of __type sentinel markers
            if let typeMarker = dict["__type"] as? String, sentinelTypes.contains(typeMarker) {
                switch typeMarker {
                case "serverTimestamp":
                    return ["__sentinel": "serverTimestamp"]
                case "increment":
                    let n = dict["value"] ?? dict["n"] ?? 0
                    return ["__sentinel": "increment", "n": n]
                case "arrayUnion":
                    let raw = (dict["values"] as? [Any]) ?? []
                    return [
                        "__sentinel": "arrayUnion",
                        "values": try raw.map { try encodeValue($0) }
                    ]
                case "arrayRemove":
                    let raw = (dict["values"] as? [Any]) ?? []
                    return [
                        "__sentinel": "arrayRemove",
                        "values": try raw.map { try encodeValue($0) }
                    ]
                case "deleteField", "delete":
                    return ["__sentinel": "deleteField"]
                default:
                    break
                }
            }

            // (c) Regular dictionary: recursively encode
            var out: [String: Any] = [:]
            for (key, val) in dict {
                out[key] = try encodeValue(val)
            }
            return out
        }

        // Dynamic duck-typing fallback for any object exposing `path: String`
        let mirror = Mirror(reflecting: value)
        for child in mirror.children {
            if child.label == "path", let pathStr = child.value as? String {
                return ["__type": "reference", "path": pathStr]
            }
        }

        throw PyricFirestoreError.serializationError(
            "Cannot serialize type '\(type(of: value))' for Pyric bridge wire."
        )
    }

    /// Encodes an entire document payload map for write operations.
    public static func encodeWriteData(_ data: [String: Any]) throws -> [String: Any] {
        let encoded = try encodeValue(data)
        guard let result = encoded as? [String: Any] else {
            throw PyricFirestoreError.serializationError("Expected dictionary output from encodeWriteData.")
        }
        return result
    }

    // MARK: - Deserializer (Wire JSON -> Swift)

    /// Decodes a wire JSON structure, reviving `__type` and compatibility type markers.
    public static func decodeValue(
        _ value: Any?,
        referenceResolver: DocumentReferenceResolver? = nil
    ) -> Any? {
        guard let value = value, !(value is NSNull) else {
            return nil
        }

        // 1. Primitives
        if let num = value as? NSNumber {
            if CFGetTypeID(num) == CFBooleanGetTypeID() {
                return num.boolValue
            }
            if CFNumberIsFloatType(num as CFNumber) {
                return num.doubleValue
            }
            return num.int64Value
        }
        if let boolVal = value as? Bool { return boolVal }
        if let stringVal = value as? String { return stringVal }

        // 2. Arrays
        if let array = value as? [Any] {
            return array.map { decodeValue($0, referenceResolver: referenceResolver) ?? NSNull() }
        }

        // 3. Dictionaries
        if let dict = value as? [String: Any] {
            // (a) Primary __type marker
            if let typeMarker = dict["__type"] as? String {
                switch typeMarker {
                case "timestamp":
                    let sec = (dict["seconds"] as? NSNumber)?.int64Value ?? 0
                    let nanos = (dict["nanos"] as? NSNumber)?.int32Value ?? 0
                    guard sec >= -62_135_596_800 && sec <= 253_402_300_799,
                          nanos >= 0 && nanos <= 999_999_999 else {
                        return nil
                    }
                    return Timestamp(seconds: sec, nanoseconds: nanos)
                case "latlng":
                    let lat = (dict["lat"] as? NSNumber)?.doubleValue ?? 0.0
                    let lng = (dict["lng"] as? NSNumber)?.doubleValue ?? 0.0
                    guard lat.isFinite && !lat.isNaN && lat >= -90.0 && lat <= 90.0,
                          lng.isFinite && !lng.isNaN && lng >= -180.0 && lng <= 180.0 else {
                        return nil
                    }
                    return GeoPoint(latitude: lat, longitude: lng)
                case "bytes":
                    let b64 = (dict["base64"] as? String) ?? ""
                    return Base64Codec.base64UrlDecodeUnpadded(b64) ?? Data()
                case "reference":
                    let path = (dict["path"] as? String) ?? ""
                    return referenceResolver?(path) ?? DocumentReferenceHolder(path: path)
                case "vector":
                    let numbers = (dict["value"] as? [NSNumber]) ?? (dict["values"] as? [NSNumber]) ?? []
                    return VectorValue(numbers.map { $0.doubleValue })
                default:
                    break
                }
            }

            // (b) Vector sentinel marker
            if let sentinelMarker = dict["__sentinel"] as? String, sentinelMarker == "vector" {
                let numbers = (dict["values"] as? [NSNumber]) ?? (dict["value"] as? [NSNumber]) ?? []
                return VectorValue(numbers.map { $0.doubleValue })
            }

            // (c) Compatibility `type` markers
            if let compatType = dict["type"] as? String {
                switch compatType {
                case "firestore/timestamp/1.0":
                    let sec = (dict["seconds"] as? NSNumber)?.int64Value ?? 0
                    let nanos = (dict["nanoseconds"] as? NSNumber)?.int32Value ?? 0
                    guard sec >= -62_135_596_800 && sec <= 253_402_300_799,
                          nanos >= 0 && nanos <= 999_999_999 else {
                        return nil
                    }
                    return Timestamp(seconds: sec, nanoseconds: nanos)
                case "firestore/geoPoint/1.0":
                    let lat = (dict["latitude"] as? NSNumber)?.doubleValue ?? 0.0
                    let lng = (dict["longitude"] as? NSNumber)?.doubleValue ?? 0.0
                    guard lat.isFinite && !lat.isNaN && lat >= -90.0 && lat <= 90.0,
                          lng.isFinite && !lng.isNaN && lng >= -180.0 && lng <= 180.0 else {
                        return nil
                    }
                    return GeoPoint(latitude: lat, longitude: lng)
                case "firestore/bytes/1.0":
                    let b64 = (dict["bytes"] as? String) ?? ""
                    return Base64Codec.base64StdDecode(b64) ?? Data()
                default:
                    break
                }
            }

            // (c) Regular dictionary: recursively decode entries
            var out: [String: Any] = [:]
            for (key, val) in dict {
                let decoded = decodeValue(val, referenceResolver: referenceResolver)
                out[key] = decoded ?? NSNull()
            }
            return out
        }

        return value
    }

    /// Decodes document data from the `{ "json": string }` envelope returned by bridge.
    public static func decodeDocData(
        _ wireData: Any?,
        referenceResolver: DocumentReferenceResolver? = nil
    ) -> [String: Any] {
        guard let wireData = wireData, !(wireData is NSNull) else {
            return [:]
        }

        // Case 1: wireData is a raw JSON string
        if let str = wireData as? String {
            guard let data = str.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: data) else {
                return [:]
            }
            return decodeDocData(parsed, referenceResolver: referenceResolver)
        }

        // Case 2: wireData is a dictionary
        if let dict = wireData as? [String: Any] {
            // Check for { "json": "<stringified-json>" } envelope
            if let jsonStr = dict["json"] as? String {
                guard let data = jsonStr.data(using: .utf8),
                      let parsed = try? JSONSerialization.jsonObject(with: data) else {
                    return [:]
                }
                let decoded = decodeValue(parsed, referenceResolver: referenceResolver)
                return (decoded as? [String: Any]) ?? [:]
            }

            // Direct dictionary (no wrapper envelope)
            let decoded = decodeValue(dict, referenceResolver: referenceResolver)
            return (decoded as? [String: Any]) ?? [:]
        }

        return [:]
    }
}
