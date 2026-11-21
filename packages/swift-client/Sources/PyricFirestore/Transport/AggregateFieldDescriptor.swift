import Foundation

public enum AggregateFieldDescriptor: Sendable, Equatable {
    case count
    case sum(field: String, path: [String]? = nil)
    case average(field: String, path: [String]? = nil)

    public static func sum(field: String) -> AggregateFieldDescriptor {
        .sum(field: field, path: nil)
    }

    public static func average(field: String) -> AggregateFieldDescriptor {
        .average(field: field, path: nil)
    }

    public func toAnySendable() -> AnySendable {
        switch self {
        case .count:
            return .dictionary(["kind": .string("count")])
        case .sum(let field, let path):
            var dict: [String: AnySendable] = ["kind": .string("sum"), "field": .string(field)]
            if let path {
                dict["path"] = .array(path.map(AnySendable.string))
            }
            return .dictionary(dict)
        case .average(let field, let path):
            var dict: [String: AnySendable] = ["kind": .string("average"), "field": .string(field)]
            if let path {
                dict["path"] = .array(path.map(AnySendable.string))
            }
            return .dictionary(dict)
        }
    }
}
