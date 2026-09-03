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
        case field(field: String, op: String, value: AnySendable)
        case composite(kind: String, filters: [Filter])
    }

    internal let type: FilterType

    internal init(type: FilterType) {
        self.type = type
    }

    public static func == (lhs: Filter, rhs: Filter) -> Bool {
        lhs.type == rhs.type
    }

    // ── Static Field Filter Factories ────────────────────────────────────────

    public static func whereField(_ field: String, isEqualTo value: Any) -> Filter {
        whereField(FieldPath(field: field), isEqualTo: value)
    }

    public static func whereField(_ path: FieldPath, isEqualTo value: Any) -> Filter {
        Filter(type: .field(field: path.stringValue, op: "==", value: AnySendable.from(try? ValueCodec.encodeValue(value))))
    }

    public static func whereField(_ field: String, isNotEqualTo value: Any) -> Filter {
        whereField(FieldPath(field: field), isNotEqualTo: value)
    }

    public static func whereField(_ path: FieldPath, isNotEqualTo value: Any) -> Filter {
        Filter(type: .field(field: path.stringValue, op: "!=", value: AnySendable.from(try? ValueCodec.encodeValue(value))))
    }

    public static func whereField(_ field: String, isLessThan value: Any) -> Filter {
        whereField(FieldPath(field: field), isLessThan: value)
    }

    public static func whereField(_ path: FieldPath, isLessThan value: Any) -> Filter {
        Filter(type: .field(field: path.stringValue, op: "<", value: AnySendable.from(try? ValueCodec.encodeValue(value))))
    }

    public static func whereField(_ field: String, isLessThanOrEqualTo value: Any) -> Filter {
        whereField(FieldPath(field: field), isLessThanOrEqualTo: value)
    }

    public static func whereField(_ path: FieldPath, isLessThanOrEqualTo value: Any) -> Filter {
        Filter(type: .field(field: path.stringValue, op: "<=", value: AnySendable.from(try? ValueCodec.encodeValue(value))))
    }

    public static func whereField(_ field: String, isGreaterThan value: Any) -> Filter {
        whereField(FieldPath(field: field), isGreaterThan: value)
    }

    public static func whereField(_ path: FieldPath, isGreaterThan value: Any) -> Filter {
        Filter(type: .field(field: path.stringValue, op: ">", value: AnySendable.from(try? ValueCodec.encodeValue(value))))
    }

    public static func whereField(_ field: String, isGreaterThanOrEqualTo value: Any) -> Filter {
        whereField(FieldPath(field: field), isGreaterThanOrEqualTo: value)
    }

    public static func whereField(_ path: FieldPath, isGreaterThanOrEqualTo value: Any) -> Filter {
        Filter(type: .field(field: path.stringValue, op: ">=", value: AnySendable.from(try? ValueCodec.encodeValue(value))))
    }

    public static func whereField(_ field: String, arrayContains value: Any) -> Filter {
        whereField(FieldPath(field: field), arrayContains: value)
    }

    public static func whereField(_ path: FieldPath, arrayContains value: Any) -> Filter {
        Filter(type: .field(field: path.stringValue, op: "array-contains", value: AnySendable.from(try? ValueCodec.encodeValue(value))))
    }

    public static func whereField(_ field: String, arrayContainsAny values: [Any]) -> Filter {
        whereField(FieldPath(field: field), arrayContainsAny: values)
    }

    public static func whereField(_ path: FieldPath, arrayContainsAny values: [Any]) -> Filter {
        let sendable = AnySendable.from(try? ValueCodec.encodeValue(values))
        return Filter(type: .field(field: path.stringValue, op: "array-contains-any", value: sendable))
    }

    public static func whereField(_ field: String, in values: [Any]) -> Filter {
        whereField(FieldPath(field: field), in: values)
    }

    public static func whereField(_ path: FieldPath, in values: [Any]) -> Filter {
        let sendable = AnySendable.from(try? ValueCodec.encodeValue(values))
        return Filter(type: .field(field: path.stringValue, op: "in", value: sendable))
    }

    public static func whereField(_ field: String, notIn values: [Any]) -> Filter {
        whereField(FieldPath(field: field), notIn: values)
    }

    public static func whereField(_ path: FieldPath, notIn values: [Any]) -> Filter {
        let sendable = AnySendable.from(try? ValueCodec.encodeValue(values))
        return Filter(type: .field(field: path.stringValue, op: "not-in", value: sendable))
    }

    // ── Composite Boolean Factories ──────────────────────────────────────────

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

    // ── Bridge Constraint Conversion ────────────────────────────────────────

    public func toConstraintDescriptor() -> QueryConstraintDescriptor {
        switch self.type {
        case .field(let field, let op, let value):
            return .where(field: field, op: op, value: value)
        case .composite(let kind, let childFilters):
            let compiledChildren = childFilters.map { $0.toConstraintDescriptor() }
            if kind == "or" {
                return .or(compiledChildren)
            } else {
                return .and(compiledChildren)
            }
        }
    }
}
