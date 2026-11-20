import Foundation

extension FieldPath {
    public var stringRepresentation: String {
        stringValue
    }
    public var components: [String] {
        segments
    }
}

public class Filter: @unchecked Sendable, Equatable {
    internal enum FilterType: Sendable, Equatable {
        case field(field: String, fieldSegments: [String]?, op: String, value: AnySendable)
        case composite(kind: String, filters: [Filter])
    }

    internal let type: FilterType

    internal init(type: FilterType) {
        self.type = type
    }

    public static func == (lhs: Filter, rhs: Filter) -> Bool {
        lhs.type == rhs.type
    }

    private static func makeFieldFilter(
        field: String,
        segments: [String]?,
        op: String,
        encodedValue: AnySendable
    ) -> Filter {
        let explicitSegments = (segments?.contains { $0.contains(".") } == true) ? segments : nil
        return Filter(type: .field(field: field, fieldSegments: explicitSegments, op: op, value: encodedValue))
    }

    // -- Static Field Filter Factories --

    public static func whereField(_ field: String, isEqualTo value: Any) -> Filter {
        makeFieldFilter(field: field, segments: nil, op: "==", encodedValue: AnySendable.from(try? ValueCodec.encodeValue(value)))
    }

    public static func whereField(_ path: FieldPath, isEqualTo value: Any) -> Filter {
        makeFieldFilter(field: path.stringValue, segments: path.segments, op: "==", encodedValue: AnySendable.from(try? ValueCodec.encodeValue(value)))
    }

    public static func whereField(_ field: String, isNotEqualTo value: Any) -> Filter {
        makeFieldFilter(field: field, segments: nil, op: "!=", encodedValue: AnySendable.from(try? ValueCodec.encodeValue(value)))
    }

    public static func whereField(_ path: FieldPath, isNotEqualTo value: Any) -> Filter {
        makeFieldFilter(field: path.stringValue, segments: path.segments, op: "!=", encodedValue: AnySendable.from(try? ValueCodec.encodeValue(value)))
    }

    public static func whereField(_ field: String, isLessThan value: Any) -> Filter {
        makeFieldFilter(field: field, segments: nil, op: "<", encodedValue: AnySendable.from(try? ValueCodec.encodeValue(value)))
    }

    public static func whereField(_ path: FieldPath, isLessThan value: Any) -> Filter {
        makeFieldFilter(field: path.stringValue, segments: path.segments, op: "<", encodedValue: AnySendable.from(try? ValueCodec.encodeValue(value)))
    }

    public static func whereField(_ field: String, isLessThanOrEqualTo value: Any) -> Filter {
        makeFieldFilter(field: field, segments: nil, op: "<=", encodedValue: AnySendable.from(try? ValueCodec.encodeValue(value)))
    }

    public static func whereField(_ path: FieldPath, isLessThanOrEqualTo value: Any) -> Filter {
        makeFieldFilter(field: path.stringValue, segments: path.segments, op: "<=", encodedValue: AnySendable.from(try? ValueCodec.encodeValue(value)))
    }

    public static func whereField(_ field: String, isGreaterThan value: Any) -> Filter {
        makeFieldFilter(field: field, segments: nil, op: ">", encodedValue: AnySendable.from(try? ValueCodec.encodeValue(value)))
    }

    public static func whereField(_ path: FieldPath, isGreaterThan value: Any) -> Filter {
        makeFieldFilter(field: path.stringValue, segments: path.segments, op: ">", encodedValue: AnySendable.from(try? ValueCodec.encodeValue(value)))
    }

    public static func whereField(_ field: String, isGreaterThanOrEqualTo value: Any) -> Filter {
        makeFieldFilter(field: field, segments: nil, op: ">=", encodedValue: AnySendable.from(try? ValueCodec.encodeValue(value)))
    }

    public static func whereField(_ path: FieldPath, isGreaterThanOrEqualTo value: Any) -> Filter {
        makeFieldFilter(field: path.stringValue, segments: path.segments, op: ">=", encodedValue: AnySendable.from(try? ValueCodec.encodeValue(value)))
    }

    public static func whereField(_ field: String, arrayContains value: Any) -> Filter {
        makeFieldFilter(field: field, segments: nil, op: "array-contains", encodedValue: AnySendable.from(try? ValueCodec.encodeValue(value)))
    }

    public static func whereField(_ path: FieldPath, arrayContains value: Any) -> Filter {
        makeFieldFilter(field: path.stringValue, segments: path.segments, op: "array-contains", encodedValue: AnySendable.from(try? ValueCodec.encodeValue(value)))
    }

    public static func whereField(_ field: String, arrayContainsAny values: [Any]) -> Filter {
        let sendable = AnySendable.from(try? ValueCodec.encodeValue(values))
        return makeFieldFilter(field: field, segments: nil, op: "array-contains-any", encodedValue: sendable)
    }

    public static func whereField(_ path: FieldPath, arrayContainsAny values: [Any]) -> Filter {
        let sendable = AnySendable.from(try? ValueCodec.encodeValue(values))
        return makeFieldFilter(field: path.stringValue, segments: path.segments, op: "array-contains-any", encodedValue: sendable)
    }

    public static func whereField(_ field: String, in values: [Any]) -> Filter {
        let sendable = AnySendable.from(try? ValueCodec.encodeValue(values))
        return makeFieldFilter(field: field, segments: nil, op: "in", encodedValue: sendable)
    }

    public static func whereField(_ path: FieldPath, in values: [Any]) -> Filter {
        let sendable = AnySendable.from(try? ValueCodec.encodeValue(values))
        return makeFieldFilter(field: path.stringValue, segments: path.segments, op: "in", encodedValue: sendable)
    }

    public static func whereField(_ field: String, notIn values: [Any]) -> Filter {
        let sendable = AnySendable.from(try? ValueCodec.encodeValue(values))
        return makeFieldFilter(field: field, segments: nil, op: "not-in", encodedValue: sendable)
    }

    public static func whereField(_ path: FieldPath, notIn values: [Any]) -> Filter {
        let sendable = AnySendable.from(try? ValueCodec.encodeValue(values))
        return makeFieldFilter(field: path.stringValue, segments: path.segments, op: "not-in", encodedValue: sendable)
    }

    // -- Composite Boolean Factories --

    public static func andFilter(_ filters: [Filter]) -> Filter {
        Filter(type: .composite(kind: "and", filters: filters))
    }

    public static func and(_ filters: Filter...) -> Filter {
        andFilter(filters)
    }

    public static func orFilter(_ filters: [Filter]) -> Filter {
        Filter(type: .composite(kind: "or", filters: filters))
    }

    public static func or(_ filters: Filter...) -> Filter {
        orFilter(filters)
    }

    // -- Bridge Constraint Conversion --

    public func toConstraintDescriptor() -> QueryConstraintDescriptor {
        switch self.type {
        case .field(let field, let fieldSegments, let op, let value):
            return .where(field: field, fieldSegments: fieldSegments, op: op, value: value)
        case .composite(let kind, let childFilters):
            let compiledChildren = childFilters.compactMap { child -> QueryConstraintDescriptor? in
                if case .composite(_, let nested) = child.type, nested.isEmpty {
                    return nil
                }
                return child.toConstraintDescriptor()
            }
            if kind == "or" {
                return .or(compiledChildren)
            } else {
                return .and(compiledChildren)
            }
        }
    }
}
