import Foundation

// -- Descriptors & Target Types --

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
    case `where`(field: String, fieldSegments: [String]? = nil, op: String, value: AnySendable)
    case and([QueryConstraintDescriptor])
    case or([QueryConstraintDescriptor])
    case orderBy(field: String, fieldSegments: [String]? = nil, direction: String?)
    case limit(n: Int)
    case limitToLast(n: Int)
    case startAt(values: [AnySendable], fromSnapshot: Bool = false)
    case startAfter(values: [AnySendable], fromSnapshot: Bool = false)
    case endAt(values: [AnySendable], fromSnapshot: Bool = false)
    case endBefore(values: [AnySendable], fromSnapshot: Bool = false)

    public func toAnySendable() -> AnySendable {
        switch self {
        case .where(let field, let fieldSegments, let op, let value):
            var dict: [String: AnySendable] = [
                "kind": .string("where"),
                "field": .string(field),
                "op": .string(op),
                "value": value
            ]
            if let fieldSegments {
                dict["fieldSegments"] = .array(fieldSegments.map(AnySendable.string))
            }
            return .dictionary(dict)
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
        case .orderBy(let field, let fieldSegments, let direction):
            var dict: [String: AnySendable] = [
                "kind": .string("orderBy"),
                "field": .string(field)
            ]
            if let fieldSegments {
                dict["fieldSegments"] = .array(fieldSegments.map(AnySendable.string))
            }
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
        case .startAt(let values, let fromSnapshot):
            var dict: [String: AnySendable] = [
                "kind": .string("startAt"),
                "values": .array(values)
            ]
            if fromSnapshot { dict["fromSnapshot"] = .bool(true) }
            return .dictionary(dict)
        case .startAfter(let values, let fromSnapshot):
            var dict: [String: AnySendable] = [
                "kind": .string("startAfter"),
                "values": .array(values)
            ]
            if fromSnapshot { dict["fromSnapshot"] = .bool(true) }
            return .dictionary(dict)
        case .endAt(let values, let fromSnapshot):
            var dict: [String: AnySendable] = [
                "kind": .string("endAt"),
                "values": .array(values)
            ]
            if fromSnapshot { dict["fromSnapshot"] = .bool(true) }
            return .dictionary(dict)
        case .endBefore(let values, let fromSnapshot):
            var dict: [String: AnySendable] = [
                "kind": .string("endBefore"),
                "values": .array(values)
            ]
            if fromSnapshot { dict["fromSnapshot"] = .bool(true) }
            return .dictionary(dict)
        }
    }
}
