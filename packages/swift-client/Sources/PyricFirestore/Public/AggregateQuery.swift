import Foundation

public enum AggregateSource: Int, Sendable {
    case server = 0
}

public struct AggregateField: Sendable, Equatable {
    internal let alias: String
    internal let descriptor: AggregateFieldDescriptor
    internal let isCount: Bool

    public static func count() -> AggregateField {
        AggregateField(alias: "count", descriptor: .count, isCount: true)
    }

    public static func sum(_ field: String) -> AggregateField {
        AggregateField(alias: "sum_\(field)", descriptor: .sum(field: field), isCount: false)
    }

    public static func sum(_ fieldPath: FieldPath) -> AggregateField {
        sum(fieldPath.stringValue)
    }

    public static func average(_ field: String) -> AggregateField {
        AggregateField(alias: "avg_\(field)", descriptor: .average(field: field), isCount: false)
    }

    public static func average(_ fieldPath: FieldPath) -> AggregateField {
        average(fieldPath.stringValue)
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
        let target = query.compileTarget()

        if aggregateFields.count == 1 && aggregateFields[0].isCount {
            let countResult = try await query.firestore.bridgeClient.count(
                source: target,
                actAs: query.firestore.effectiveAuthLens
            )
            return AggregateQuerySnapshot(
                query: self,
                countValue: countResult,
                results: ["count": Double(countResult)]
            )
        }

        var spec: [String: AggregateFieldDescriptor] = [:]
        for field in aggregateFields {
            spec[field.alias] = field.descriptor
        }

        let results = try await query.firestore.bridgeClient.aggregate(
            source: target,
            spec: spec,
            actAs: query.firestore.effectiveAuthLens
        )
        let countVal = Int(results["count"]??.rounded() ?? 0)

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
        Task {
            do {
                let snap = try await getAggregation(source: source)
                query.firestore.settings.dispatchQueue.async {
                    completion(snap, nil)
                }
            } catch {
                query.firestore.settings.dispatchQueue.async {
                    completion(nil, error)
                }
            }
        }
    }
}

public final class AggregateQuerySnapshot: @unchecked Sendable {
    public let query: AggregateQuery
    private let countValue: Int
    private let results: [String: Double?]

    internal init(query: AggregateQuery, countValue: Int, results: [String: Double?]) {
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
        guard let optVal = results[aggregateField.alias] else {
            return nil
        }
        guard let val = optVal else {
            return NSNull()
        }
        return NSNumber(value: val)
    }
}
