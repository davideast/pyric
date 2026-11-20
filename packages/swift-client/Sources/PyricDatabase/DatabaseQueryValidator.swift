import Foundation
import PyricFirestore

package enum DatabaseQueryValidationError: Error, LocalizedError, Equatable, Sendable {
    case multipleOrderBy
    case emptyOrderByChildPath
    case invalidOrderByChildPath(String)
    case duplicateStartBound
    case duplicateEndBound
    case invalidChildKey(String)
    case invalidBoundValueType
    case childKeyNotAllowedForOrderByKey
    case nonStringBoundForOrderByKey
    case nonPositiveLimit
    case multipleLimits

    package var errorDescription: String? {
        switch self {
        case .multipleOrderBy:
            return "You cannot combine multiple queryOrdered calls on the same DatabaseQuery."
        case .emptyOrderByChildPath:
            return "queryOrdered(byChild:) path must not be empty."
        case .invalidOrderByChildPath(let raw):
            return "Invalid child path (\(raw)) passed to queryOrdered(byChild:)."
        case .duplicateStartBound:
            return "Cannot combine multiple lower bounds (queryStarting / queryEqual) on the same DatabaseQuery."
        case .duplicateEndBound:
            return "Cannot combine multiple upper bounds (queryEnding / queryEqual) on the same DatabaseQuery."
        case .invalidChildKey(let key):
            return "Invalid childKey (\(key)) passed to query cursor; expected a single valid key token."
        case .invalidBoundValueType:
            return "Query bound value must be nil, Bool, String, or a finite number."
        case .childKeyNotAllowedForOrderByKey:
            return "Cannot pass a non-nil childKey cursor on a queryOrderedByKey() query."
        case .nonStringBoundForOrderByKey:
            return "Query cursor value on a queryOrderedByKey() query must be a String."
        case .nonPositiveLimit:
            return "Query limit must be greater than zero."
        case .multipleLimits:
            return "Cannot combine multiple queryLimited calls on the same DatabaseQuery."
        }
    }
}

internal enum DatabaseQueryValidator {

    internal static func validateOrderByChild(
        _ rawPath: String,
        existingOrderBy: [String: AnySendable]?
    ) throws -> String {
        if existingOrderBy != nil {
            throw DatabaseQueryValidationError.multipleOrderBy
        }
        let trimmed = rawPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if trimmed.isEmpty {
            throw DatabaseQueryValidationError.emptyOrderByChildPath
        }
        let segments = trimmed.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if segments.isEmpty {
            throw DatabaseQueryValidationError.emptyOrderByChildPath
        }
        for segment in segments {
            if segment.isEmpty || containsInvalidKeyCharacters(segment) {
                throw DatabaseQueryValidationError.invalidOrderByChildPath(rawPath)
            }
        }
        return segments.joined(separator: "/")
    }

    internal static func validateOrderByKey(
        existingOrderBy: [String: AnySendable]?,
        existingBounds: [[String: AnySendable]]
    ) throws {
        if existingOrderBy != nil {
            throw DatabaseQueryValidationError.multipleOrderBy
        }
        for bound in existingBounds {
            if bound["key"] != nil {
                throw DatabaseQueryValidationError.childKeyNotAllowedForOrderByKey
            }
            if bound["value"]?.stringValue == nil {
                throw DatabaseQueryValidationError.nonStringBoundForOrderByKey
            }
        }
    }

    internal static func validateOrderByOther(existingOrderBy: [String: AnySendable]?) throws {
        if existingOrderBy != nil {
            throw DatabaseQueryValidationError.multipleOrderBy
        }
    }

    internal static func validateBound(
        kind: String,
        value: Any?,
        childKey: String?,
        existingOrderBy: [String: AnySendable]?,
        existingBounds: [[String: AnySendable]]
    ) throws -> [String: AnySendable] {
        let isStart = (kind == "startAt" || kind == "startAfter" || kind == "equalTo")
        let isEnd = (kind == "endAt" || kind == "endBefore" || kind == "equalTo")

        if isStart && hasStartBound(existingBounds) {
            throw DatabaseQueryValidationError.duplicateStartBound
        }
        if isEnd && hasEndBound(existingBounds) {
            throw DatabaseQueryValidationError.duplicateEndBound
        }

        if let childKey {
            if childKey.isEmpty || childKey.contains("/") || containsInvalidKeyCharacters(childKey) {
                throw DatabaseQueryValidationError.invalidChildKey(childKey)
            }
        }

        let encodedValue = try encodeScalarBoundValue(value)

        if existingOrderBy?["kind"]?.stringValue == "key" {
            if childKey != nil {
                throw DatabaseQueryValidationError.childKeyNotAllowedForOrderByKey
            }
            if encodedValue.stringValue == nil {
                throw DatabaseQueryValidationError.nonStringBoundForOrderByKey
            }
        }

        var bound: [String: AnySendable] = [
            "kind": .string(kind),
            "value": encodedValue,
        ]
        if let childKey {
            bound["key"] = .string(childKey)
        }
        return bound
    }

    internal static func validateLimit(
        kind: String,
        limit: UInt,
        existingLimit: [String: AnySendable]?
    ) throws -> [String: AnySendable] {
        if limit == 0 {
            throw DatabaseQueryValidationError.nonPositiveLimit
        }
        if existingLimit != nil {
            throw DatabaseQueryValidationError.multipleLimits
        }
        return [
            "kind": .string(kind),
            "n": .int(Int64(limit)),
        ]
    }

    private static func hasStartBound(_ bounds: [[String: AnySendable]]) -> Bool {
        bounds.contains { item in
            guard let kind = item["kind"]?.stringValue else { return false }
            return kind == "startAt" || kind == "startAfter" || kind == "equalTo"
        }
    }

    private static func hasEndBound(_ bounds: [[String: AnySendable]]) -> Bool {
        bounds.contains { item in
            guard let kind = item["kind"]?.stringValue else { return false }
            return kind == "endAt" || kind == "endBefore" || kind == "equalTo"
        }
    }

    private static func encodeScalarBoundValue(_ value: Any?) throws -> AnySendable {
        if value == nil || value is NSNull {
            return .null
        }
        let encoded = RtdbValueCodec.toAnySendable(value)
        switch encoded {
        case .null, .bool, .int, .string:
            return encoded
        case .double(let d):
            guard d.isFinite else {
                throw DatabaseQueryValidationError.invalidBoundValueType
            }
            return encoded
        case .array, .dictionary:
            throw DatabaseQueryValidationError.invalidBoundValueType
        }
    }

    private static func containsInvalidKeyCharacters(_ segment: String) -> Bool {
        for scalar in segment.unicodeScalars {
            let v = scalar.value
            if v <= 0x1F || v == 0x7F {
                return true
            }
            // '.', '#', '$', '[', ']'
            if v == 0x2E || v == 0x23 || v == 0x24 || v == 0x5B || v == 0x5D {
                return true
            }
        }
        return false
    }
}
