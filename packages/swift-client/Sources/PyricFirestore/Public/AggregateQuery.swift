import Foundation

public enum AggregateSource: Int, Sendable {
    case server = 0
}

public struct AggregateField: Sendable, Equatable {
    internal enum Kind: Sendable, Equatable {
        case count
        case sum
        case average
    }

    internal let alias: String
    internal let descriptor: AggregateFieldDescriptor
    internal let kind: Kind

    internal var isCount: Bool {
        kind == .count
    }

    private static func canonicalAliasSuffix(_ segments: [String]) -> String {
        segments
            .map {
                $0.replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: ".", with: "\\.")
            }
            .joined(separator: ".")
    }

    public static func count() -> AggregateField {
        AggregateField(alias: "count", descriptor: .count, kind: .count)
    }

    public static func sum(_ field: String) -> AggregateField {
        let segments = field.components(separatedBy: ".")
        return AggregateField(
            alias: "sum_\(canonicalAliasSuffix(segments))",
            descriptor: .sum(field: field, path: nil),
            kind: .sum
        )
    }

    public static func sum(_ fieldPath: FieldPath) -> AggregateField {
        let segments = fieldPath.segments
        let hasLiteralDot = segments.contains { $0.contains(".") }
        return AggregateField(
            alias: "sum_\(canonicalAliasSuffix(segments))",
            descriptor: .sum(field: fieldPath.stringValue, path: hasLiteralDot ? segments : nil),
            kind: .sum
        )
    }

    public static func average(_ field: String) -> AggregateField {
        let segments = field.components(separatedBy: ".")
        return AggregateField(
            alias: "avg_\(canonicalAliasSuffix(segments))",
            descriptor: .average(field: field, path: nil),
            kind: .average
        )
    }

    public static func average(_ fieldPath: FieldPath) -> AggregateField {
        let segments = fieldPath.segments
        let hasLiteralDot = segments.contains { $0.contains(".") }
        return AggregateField(
            alias: "avg_\(canonicalAliasSuffix(segments))",
            descriptor: .average(field: fieldPath.stringValue, path: hasLiteralDot ? segments : nil),
            kind: .average
        )
    }
}

public final class AggregateQuery: @unchecked Sendable {
    public let query: Query
    internal let aggregateFields: [AggregateField]

    internal init(query: Query, aggregateFields: [AggregateField]) {
        self.query = query
        self.aggregateFields = aggregateFields
    }

    public func getAggregation(
        source: AggregateSource = .server
    ) async throws -> AggregateQuerySnapshot {
        try await getAggregation(turn: query.firestore.takeTurn())
    }

    private func getAggregation(turn: OperationTurn) async throws -> AggregateQuerySnapshot {
        do {
            try query.firestore.lifecycle.ensureActiveAndMarkStarted()
        } catch {
            await query.firestore.bridgeClient.pass(turn: turn)
            throw error
        }
        guard query.firestore.lifecycle.isNetworkEnabled else {
            await query.firestore.bridgeClient.pass(turn: turn)
            throw PyricBridgeError.unavailable("Aggregate queries cannot be executed while the client is offline.")
        }
        let target = query.compileTarget()

        if aggregateFields.count == 1 && aggregateFields[0].isCount {
            let countResult = try await query.firestore.bridgeClient.count64(
                turn: turn,
                source: target,
                actAs: query.firestore.effectiveAuthLens
            )
            return AggregateQuerySnapshot(
                query: self,
                countValue: countResult,
                results: ["count": .int64(countResult)]
            )
        }

        var spec: [String: AggregateFieldDescriptor] = [:]
        for field in aggregateFields {
            spec[field.alias] = field.descriptor
        }

        let results = try await query.firestore.bridgeClient.aggregateValues(
            turn: turn,
            source: target,
            spec: spec,
            actAs: query.firestore.effectiveAuthLens
        )
        let countVal: Int64
        switch results["count"] {
        case .int64(let i):
            countVal = i
        case .double(let d):
            countVal = Int64(d.rounded())
        default:
            countVal = 0
        }

        return AggregateQuerySnapshot(
            query: self,
            countValue: countVal,
            results: results
        )
    }

    public func getAggregation(
        source: AggregateSource = .server,
        completion: @escaping @Sendable (AggregateQuerySnapshot?, Error?) -> Void
    ) {
        query.firestore.runInCallOrder(completion: completion) { turn in
            try await self.getAggregation(turn: turn)
        }
    }
}

public final class AggregateQuerySnapshot: @unchecked Sendable {
    public let query: AggregateQuery
    private let countValue: Int64
    private let results: [String: AggregateScalarValue]

    internal init(query: AggregateQuery, countValue: Int64, results: [String: AggregateScalarValue]) {
        self.query = query
        self.countValue = countValue
        self.results = results
    }

    public var count: NSNumber {
        NSNumber(value: countValue)
    }

    public func get(_ aggregateField: AggregateField) -> Any? {
        if aggregateField.isCount {
            return count
        }
        guard let scalar = results[aggregateField.alias] else {
            return nil
        }
        switch aggregateField.kind {
        case .count:
            return count
        case .sum:
            switch scalar {
            case .int64(let i):
                return NSNumber(value: i)
            case .double(let d):
                return NSNumber(value: d)
            case .null:
                return NSNumber(value: Int64(0))
            }
        case .average:
            switch scalar {
            case .int64(let i):
                return NSNumber(value: Double(i))
            case .double(let d):
                return NSNumber(value: d)
            case .null:
                return NSNull()
            }
        }
    }
}
