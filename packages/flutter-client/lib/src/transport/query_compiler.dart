import 'codecs.dart';

/// Set of valid Firestore WHERE filter operators accepted by Pyric wire protocol.
const Set<String> validWhereOperators = {
  '<',
  '<=',
  '==',
  '!=',
  '>=',
  '>',
  'array-contains',
  'array-contains-any',
  'in',
  'not-in',
};

// ─── Target Descriptors ─────────────────────────────────────────────────────

/// Base class for all Firestore target descriptors on the Pyric bridge.
abstract class TargetDescriptor {
  const TargetDescriptor();

  /// Converts descriptor into canonical wire JSON format.
  Map<String, dynamic> toMap();
}

/// Target descriptor pointing to a specific document path.
class DocumentTargetDescriptor extends TargetDescriptor {
  final String path;

  const DocumentTargetDescriptor(this.path);

  @override
  Map<String, dynamic> toMap() => {
        '__ref': 'doc',
        'path': path,
      };

  @override
  String toString() => 'DocumentTargetDescriptor($path)';
}

/// Target descriptor pointing to a collection path.
class CollectionTargetDescriptor extends TargetDescriptor {
  final String path;

  const CollectionTargetDescriptor(this.path);

  @override
  Map<String, dynamic> toMap() => {
        '__ref': 'collection',
        'path': path,
      };

  @override
  String toString() => 'CollectionTargetDescriptor($path)';
}

/// Target descriptor pointing to a collection group ID.
class CollectionGroupTargetDescriptor extends TargetDescriptor {
  final String collectionId;

  const CollectionGroupTargetDescriptor(this.collectionId);

  @override
  Map<String, dynamic> toMap() => {
        '__ref': 'group',
        'collectionId': collectionId,
      };

  @override
  String toString() => 'CollectionGroupTargetDescriptor($collectionId)';
}

/// Target descriptor representing a filtered and ordered query.
class QueryTargetDescriptor extends TargetDescriptor {
  final TargetDescriptor source;
  final List<QueryConstraint> constraints;

  const QueryTargetDescriptor({
    required this.source,
    this.constraints = const [],
  });

  @override
  Map<String, dynamic> toMap() {
    final compiledConstraints = constraints.map((c) => c.toMap()).toList();
    return QueryCompiler.compileTargetDescriptor(
      source: source.toMap(),
      constraints: compiledConstraints,
    );
  }

  @override
  String toString() =>
      'QueryTargetDescriptor(source: $source, constraints: $constraints)';
}

// ─── Query Constraints ──────────────────────────────────────────────────────

/// Base class for individual query constraints.
abstract class QueryConstraint {
  const QueryConstraint();

  Map<String, dynamic> toMap();
}

/// Relational or membership filter constraint on a document field.
class WhereConstraint extends QueryConstraint {
  final String field;
  final String op;
  final dynamic value;

  WhereConstraint(this.field, this.op, this.value) {
    if (!validWhereOperators.contains(op)) {
      throw ArgumentError('Invalid where operator: "$op". Allowed: $validWhereOperators');
    }
  }

  @override
  Map<String, dynamic> toMap() => {
        'kind': 'where',
        'field': field,
        'op': op,
        'value': encodeValue(value),
      };
}

/// Composite filter constraint combining child filters via `and` or `or`.
class CompositeFilterConstraint extends QueryConstraint {
  final String kind;
  final List<QueryConstraint> filters;

  CompositeFilterConstraint(this.kind, this.filters) {
    if (kind != 'and' && kind != 'or') {
      throw ArgumentError('Composite filter kind must be "and" or "or", got "$kind"');
    }
  }

  @override
  Map<String, dynamic> toMap() => {
        'kind': kind,
        'filters': filters.map((f) => f.toMap()).toList(),
      };
}

/// Ordering constraint on a document field.
class OrderByConstraint extends QueryConstraint {
  final String field;
  final String direction;

  OrderByConstraint(this.field, {this.direction = 'asc'}) {
    if (direction != 'asc' && direction != 'desc') {
      throw ArgumentError('Order direction must be "asc" or "desc", got "$direction"');
    }
  }

  @override
  Map<String, dynamic> toMap() => {
        'kind': 'orderBy',
        'field': field,
        'direction': direction,
      };
}

/// Limit constraint capping result count to [limit].
class LimitConstraint extends QueryConstraint {
  final int limit;

  const LimitConstraint(this.limit);

  @override
  Map<String, dynamic> toMap() => {
        'kind': 'limit',
        'n': limit,
      };
}

/// Limit-to-last constraint taking [limit] documents relative to ordering.
class LimitToLastConstraint extends QueryConstraint {
  final int limit;

  const LimitToLastConstraint(this.limit);

  @override
  Map<String, dynamic> toMap() => {
        'kind': 'limitToLast',
        'n': limit,
      };
}

/// Cursor pagination constraint (`startAt`, `startAfter`, `endAt`, `endBefore`).
class CursorConstraint extends QueryConstraint {
  final String kind;
  final List<dynamic> values;

  CursorConstraint(this.kind, this.values) {
    const validKinds = {'startAt', 'startAfter', 'endAt', 'endBefore'};
    if (!validKinds.contains(kind)) {
      throw ArgumentError('Invalid cursor kind: "$kind". Allowed: $validKinds');
    }
  }

  @override
  Map<String, dynamic> toMap() => {
        'kind': kind,
        'values': values.map(encodeValue).toList(),
      };
}

// ─── Query Compiler ─────────────────────────────────────────────────────────

/// Compiles target descriptors and constraints for Pyric bridge RPCs and listeners.
class QueryCompiler {
  /// Compiles a target descriptor. If constraints are empty, returns [source] directly;
  /// otherwise wraps in `{'__ref': 'query', 'source': source, 'constraints': [...]}`.
  static Map<String, dynamic> compileTargetDescriptor({
    required Map<String, dynamic> source,
    List<Map<String, dynamic>> constraints = const [],
  }) {
    validateConstraints(constraints);
    if (constraints.isEmpty) {
      return Map<String, dynamic>.from(source);
    }
    return {
      '__ref': 'query',
      'source': Map<String, dynamic>.from(source),
      'constraints': List<Map<String, dynamic>>.from(constraints),
    };
  }

  /// Builds a document target descriptor.
  static Map<String, dynamic> compileDocumentTarget(String path) {
    return {'__ref': 'doc', 'path': path};
  }

  /// Builds a collection target descriptor.
  static Map<String, dynamic> compileCollectionTarget(String path) {
    return {'__ref': 'collection', 'path': path};
  }

  /// Builds a collection group target descriptor.
  static Map<String, dynamic> compileGroupTarget(String collectionId) {
    return {'__ref': 'group', 'collectionId': collectionId};
  }

  /// Compiles a `where` constraint.
  static Map<String, dynamic> compileWhere(
    String field,
    String op,
    dynamic value,
  ) {
    if (!validWhereOperators.contains(op)) {
      throw ArgumentError('Invalid where operator: "$op". Allowed: $validWhereOperators');
    }
    return {
      'kind': 'where',
      'field': field,
      'op': op,
      'value': encodeValue(value),
    };
  }

  /// Compiles an `orderBy` constraint.
  static Map<String, dynamic> compileOrderBy(
    String field, {
    String direction = 'asc',
  }) {
    if (direction != 'asc' && direction != 'desc') {
      throw ArgumentError('Order direction must be "asc" or "desc", got "$direction"');
    }
    return {
      'kind': 'orderBy',
      'field': field,
      'direction': direction,
    };
  }

  /// Compiles a `limit` constraint.
  static Map<String, dynamic> compileLimit(int limit) {
    return {'kind': 'limit', 'n': limit};
  }

  /// Compiles a `limitToLast` constraint.
  static Map<String, dynamic> compileLimitToLast(int limit) {
    return {'kind': 'limitToLast', 'n': limit};
  }

  /// Compiles a cursor constraint (`startAt`, `startAfter`, `endAt`, `endBefore`).
  static Map<String, dynamic> compileCursor(String kind, List<dynamic> values) {
    const validKinds = {'startAt', 'startAfter', 'endAt', 'endBefore'};
    if (!validKinds.contains(kind)) {
      throw ArgumentError('Invalid cursor kind: "$kind". Allowed: $validKinds');
    }
    return {
      'kind': kind,
      'values': values.map(encodeValue).toList(),
    };
  }

  /// Validates a list of compiled constraints before transmission.
  static void validateConstraints(List<Map<String, dynamic>> constraints) {
    final hasLimitToLast = constraints.any((c) => c['kind'] == 'limitToLast');
    final hasOrderBy = constraints.any((c) => c['kind'] == 'orderBy');

    if (hasLimitToLast && !hasOrderBy) {
      throw ArgumentError('limitToLast() queries require at least one orderBy clause.');
    }
  }
}
