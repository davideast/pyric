import Foundation

/// A FieldPath refers to a field in a document. The path may consist of a single field name
/// (referring to a top-level field in the document) or a list of field names (referring to a nested field).
public struct FieldPath: Equatable, Hashable, Sendable {
    public let segments: [String]

    public init(_ segments: [String]) {
        precondition(!segments.isEmpty, "FieldPath must not be empty.")
        for segment in segments {
            precondition(!segment.isEmpty, "FieldPath segments must not be empty.")
        }
        self.segments = segments
    }

    public init(field: String) {
        self.init([field])
    }

    public static func documentID() -> FieldPath {
        FieldPath(["__name__"])
    }

    public var stringValue: String {
        segments.joined(separator: ".")
    }
}

extension FieldPath: CustomStringConvertible {
    public var description: String {
        stringValue
    }
}
