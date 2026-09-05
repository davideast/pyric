import Foundation

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
