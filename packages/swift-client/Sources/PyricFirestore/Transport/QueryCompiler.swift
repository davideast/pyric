import Foundation

public enum QueryCompiler {
    private static let inequalityOperators: Set<String> = ["<", "<=", ">", ">=", "!=", "not-in"]

    internal struct NormalizedOrderClause: Equatable {
        let segments: [String]
        let direction: String
    }

    /// Compiles a Query instance into a TargetDescriptor.
    public static func compile(query: Query) throws -> TargetDescriptor {
        var resolvedConstraints = query.constraints
        try validateConstraints(resolvedConstraints)

        if query.startSnapshotCursor != nil || query.endSnapshotCursor != nil {
            let normalizedOrders = computeNormalizedOrders(from: resolvedConstraints)
            if let startSpec = query.startSnapshotCursor {
                let values = try extractSnapshotCursorValues(spec: startSpec, orders: normalizedOrders)
                resolvedConstraints.append(
                    startSpec.inclusive
                        ? .startAt(values: values, fromSnapshot: true)
                        : .startAfter(values: values, fromSnapshot: true)
                )
            }
            if let endSpec = query.endSnapshotCursor {
                let values = try extractSnapshotCursorValues(spec: endSpec, orders: normalizedOrders)
                resolvedConstraints.append(
                    endSpec.inclusive
                        ? .endAt(values: values, fromSnapshot: true)
                        : .endBefore(values: values, fromSnapshot: true)
                )
            }
        }

        if resolvedConstraints.isEmpty {
            return query.rootSource
        }

        return .query(
            source: TargetDescriptor.Box(query.rootSource),
            constraints: resolvedConstraints
        )
    }

    /// Validates logical constraint invariants before bridge dispatch.
    public static func validateConstraints(_ constraints: [QueryConstraintDescriptor]) throws {
        let hasLimitToLast = constraints.contains { descriptor in
            if case .limitToLast = descriptor { return true }
            return false
        }
        let hasOrderBy = constraints.contains { descriptor in
            if case .orderBy = descriptor { return true }
            return false
        }

        if hasLimitToLast && !hasOrderBy {
            throw PyricFirestoreError.invalidArgument(
                "Queries with limitToLast() require at least one order(by:) clause."
            )
        }
    }

    internal static func computeNormalizedOrders(
        from constraints: [QueryConstraintDescriptor]
    ) -> [NormalizedOrderClause] {
        var explicitOrders: [NormalizedOrderClause] = []
        var inequalityFieldList: [[String]] = []

        for constraint in constraints {
            switch constraint {
            case .orderBy(let field, let fieldSegments, let direction):
                let segs = fieldSegments ?? field.components(separatedBy: ".")
                explicitOrders.append(
                    NormalizedOrderClause(segments: segs, direction: direction ?? "asc")
                )
            case .where, .and, .or:
                collectInequalitySegments(from: constraint, into: &inequalityFieldList)
            default:
                break
            }
        }

        let lastDirection = explicitOrders.last?.direction ?? "asc"
        var result = explicitOrders
        var seen: Set<[String]> = Set(explicitOrders.map(\.segments))

        var uniqueInequalities: [[String]] = []
        for segs in inequalityFieldList {
            if segs != ["__name__"] && !seen.contains(segs) && !uniqueInequalities.contains(segs) {
                uniqueInequalities.append(segs)
            }
        }
        uniqueInequalities.sort(by: compareSegments)
        for segs in uniqueInequalities {
            seen.insert(segs)
            result.append(NormalizedOrderClause(segments: segs, direction: lastDirection))
        }

        if !seen.contains(["__name__"]) {
            result.append(NormalizedOrderClause(segments: ["__name__"], direction: lastDirection))
        }
        return result
    }

    private static func collectInequalitySegments(
        from constraint: QueryConstraintDescriptor,
        into out: inout [[String]]
    ) {
        switch constraint {
        case .where(let field, let fieldSegments, let op, _):
            if inequalityOperators.contains(op) {
                out.append(fieldSegments ?? field.components(separatedBy: "."))
            }
        case .and(let filters), .or(let filters):
            for nested in filters {
                collectInequalitySegments(from: nested, into: &out)
            }
        default:
            break
        }
    }

    internal static func compareSegments(_ lhs: [String], _ rhs: [String]) -> Bool {
        let count = min(lhs.count, rhs.count)
        for idx in 0..<count where lhs[idx] != rhs[idx] {
            return lhs[idx] < rhs[idx]
        }
        return lhs.count < rhs.count
    }

    private static func extractSnapshotCursorValues(
        spec: SnapshotCursorSpec,
        orders: [NormalizedOrderClause]
    ) throws -> [AnySendable] {
        guard spec.snapshot.exists, let rawData = spec.snapshot.rawData else {
            throw PyricFirestoreError.invalidArgument(
                "Invalid query. DocumentSnapshot cursor requires an existing document."
            )
        }

        var values: [AnySendable] = []
        values.reserveCapacity(orders.count)
        for clause in orders {
            if clause.segments == ["__name__"] {
                values.append(
                    .dictionary([
                        "__type": .string("reference"),
                        "path": .string(spec.snapshot.reference.path)
                    ])
                )
                continue
            }
            guard let rawValue = lookupSnapshotValue(in: rawData, segments: clause.segments) else {
                let label = clause.segments.joined(separator: ".")
                throw PyricFirestoreError.invalidArgument(
                    "Invalid query. DocumentSnapshot cursor is missing ordered field '\(label)'."
                )
            }
            let encoded = try ValueCodec.encodeValue(rawValue)
            values.append(AnySendable.from(encoded))
        }
        return values
    }

    private static func lookupSnapshotValue(
        in root: [String: Any],
        segments: [String]
    ) -> Any? {
        var current: Any = root
        for segment in segments {
            guard let dict = current as? [String: Any],
                  let next = dict[segment] else {
                return nil
            }
            current = next
        }
        return current
    }
}
