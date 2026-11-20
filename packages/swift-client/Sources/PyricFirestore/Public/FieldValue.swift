import Foundation

/// Sentinel values that can be used when writing document fields with setData() or updateData().
public class FieldValue: Equatable, @unchecked Sendable {
    internal let sentinel: any PyricSentinel

    internal init(sentinel: any PyricSentinel) {
        self.sentinel = sentinel
    }

    public static func serverTimestamp() -> FieldValue {
        FieldValue(sentinel: PyricServerTimestampSentinel())
    }

    public static func delete() -> FieldValue {
        FieldValue(sentinel: PyricDeleteFieldSentinel())
    }

    public static func increment(_ n: Double) -> FieldValue {
        FieldValue(sentinel: PyricIncrementSentinel(n))
    }

    public static func increment(_ n: Int64) -> FieldValue {
        FieldValue(sentinel: PyricIncrementSentinel(n))
    }

    public static func arrayUnion(_ elements: [Any]) -> FieldValue {
        FieldValue(sentinel: PyricArrayUnionSentinel(elements))
    }

    public static func arrayRemove(_ elements: [Any]) -> FieldValue {
        FieldValue(sentinel: PyricArrayRemoveSentinel(elements))
    }

    public static func vector(_ values: [Double]) -> VectorValue {
        VectorValue(values)
    }

    public static func vector(_ values: [Float]) -> VectorValue {
        VectorValue(values)
    }

    public static func == (lhs: FieldValue, rhs: FieldValue) -> Bool {
        lhs.sentinel.isEqual(to: rhs.sentinel)
    }
}

/// A dense vector embedding representation for vector search and similarity queries.
public struct VectorValue: Equatable, Hashable, Codable, Sendable {
    public let values: [Double]

    public init(_ values: [Double]) {
        self.values = values
    }

    public init(_ values: [Float]) {
        self.values = values.map { Double($0) }
    }

    public var arrayValue: [Double] {
        values
    }

    private enum CodingKeys: String, CodingKey {
        case values = "__pyricVectorValues"
    }

    public init(from decoder: Decoder) throws {
        if let keyed = try? decoder.container(keyedBy: CodingKeys.self),
           let vec = try? keyed.decode([Double].self, forKey: .values) {
            self.values = vec
            return
        }
        let single = try decoder.singleValueContainer()
        self.values = try single.decode([Double].self)
    }

    public func encode(to encoder: Encoder) throws {
        var keyed = encoder.container(keyedBy: CodingKeys.self)
        try keyed.encode(values, forKey: .values)
    }
}
