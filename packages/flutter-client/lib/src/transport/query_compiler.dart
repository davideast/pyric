import 'codecs.dart';
import 'query_constraints.dart';

export 'query_constraints.dart';
export 'target_descriptors.dart';

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
