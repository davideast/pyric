import Foundation

public enum QueryCompiler {
    /// Compiles a Query instance into a TargetDescriptor.
    public static func compile(query: Query) throws -> TargetDescriptor {
        try validateConstraints(query.constraints)

        if query.constraints.isEmpty {
            return query.rootSource
        }

        return .query(
            source: TargetDescriptor.Box(query.rootSource),
            constraints: query.constraints
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
}
