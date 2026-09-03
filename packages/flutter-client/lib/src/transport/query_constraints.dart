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
