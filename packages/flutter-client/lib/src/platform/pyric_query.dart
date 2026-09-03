import 'dart:async';

import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart'
    as p;
import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';

import '../transport/bridge_client.dart';
import '../transport/query_compiler.dart';
import 'pyric_aggregate_query.dart';
import 'pyric_field_value_factory.dart';
import 'pyric_firestore_platform.dart';
import 'pyric_query_snapshot.dart';

/// Concrete [QueryPlatform] for querying documents over the Pyric bridge.
class PyricQuery extends QueryPlatform {
  final String path;

  @override
  final bool isCollectionGroupQuery;

  PyricQuery(
    FirebaseFirestorePlatform firestore,
    this.path, {
    Map<String, dynamic>? parameters,
    this.isCollectionGroupQuery = false,
  }) : super(firestore, parameters);

  PyricBridgeClient get _client {
    final f = firestore;
    if (f is PyricFirestorePlatform) {
      return f.bridgeClient;
    }
    throw StateError('Expected PyricFirestorePlatform, got ${f.runtimeType}');
  }

  PyricQuery _copyWithParameters(Map<String, dynamic> newParams) {
    return PyricQuery(
      firestore,
      path,
      isCollectionGroupQuery: isCollectionGroupQuery,
      parameters: Map<String, dynamic>.unmodifiable(
        Map<String, dynamic>.from(parameters)..addAll(newParams),
      ),
    );
  }

  static String _fieldToString(dynamic field) {
    if (field is FieldPath) {
      return field.components.join('.');
    }
    return field.toString();
  }

  static Map<String, dynamic> _compileFilterMap(Map<dynamic, dynamic> map) {
    if (map.containsKey('fieldPath')) {
      final rawField = map['fieldPath'];
      final field = _fieldToString(rawField);
      final op = map['op'].toString();
      final val = unwrapFieldValues(map['value']);
      return QueryCompiler.compileWhere(field, op, val);
    }
    final op = (map['op'] as String?)?.toLowerCase();
    if (op == 'and' || op == 'or') {
      final queries = map['queries'] as Iterable? ?? const [];
      final childFilters = <Map<String, dynamic>>[];
      for (final q in queries) {
        if (q is Map) {
          childFilters.add(_compileFilterMap(q));
        }
      }
      return {
        'kind': op,
        'filters': childFilters,
      };
    }
    throw ArgumentError('Unsupported filter map: $map');
  }

  /// Compiles query target descriptor and constraints for bridge RPC / subscription.
  Map<String, dynamic> compileTarget() {
    final source = isCollectionGroupQuery
        ? QueryCompiler.compileGroupTarget(path)
        : QueryCompiler.compileCollectionTarget(path);

    final constraints = <Map<String, dynamic>>[];

    // Where filters
    final whereList = parameters['where'] as Iterable?;
    if (whereList != null) {
      for (final cond in whereList) {
        if (cond is List && cond.length >= 3) {
          final field = _fieldToString(cond[0]);
          final op = cond[1].toString();
          final val = unwrapFieldValues(cond[2]);
          constraints.add(QueryCompiler.compileWhere(field, op, val));
        }
      }
    }

    // Filter tree (from whereFilter)
    final filterMap = parameters['filters'] as Map?;
    if (filterMap != null) {
      constraints.add(_compileFilterMap(filterMap));
    }

    // OrderBy clauses
    final orderList = parameters['orderBy'] as Iterable?;
    if (orderList != null) {
      for (final order in orderList) {
        if (order is List && order.isNotEmpty) {
          final field = _fieldToString(order[0]);
          final descending = order.length > 1 && order[1] == true;
          constraints.add(QueryCompiler.compileOrderBy(
            field,
            direction: descending ? 'desc' : 'asc',
          ));
        }
      }
    }

    // Limit / LimitToLast
    final limitVal = parameters['limit'] as int?;
    if (limitVal != null) {
      constraints.add(QueryCompiler.compileLimit(limitVal));
    }
    final limitToLastVal = parameters['limitToLast'] as int?;
    if (limitToLastVal != null) {
      constraints.add(QueryCompiler.compileLimitToLast(limitToLastVal));
    }

    // Cursors
    for (final kind in const ['startAt', 'startAfter', 'endAt', 'endBefore']) {
      final cursorVal = parameters[kind];
      if (cursorVal is Iterable) {
        constraints.add(QueryCompiler.compileCursor(
          kind,
          cursorVal.map(unwrapFieldValues).toList(),
        ));
      }
    }

    return QueryCompiler.compileTargetDescriptor(
      source: source,
      constraints: constraints,
    );
  }

  @override
  QueryPlatform where(Iterable<List<dynamic>> conditions) {
    final existing = List<List<dynamic>>.from(
      (parameters['where'] as Iterable? ?? const []).map((e) => List<dynamic>.from(e as Iterable)),
    );
    for (final c in conditions) {
      existing.add(List<dynamic>.from(c));
    }
    return _copyWithParameters(<String, dynamic>{
      'where': existing,
    });
  }

  @override
  QueryPlatform whereFilter(FilterPlatformInterface filter) {
    return _copyWithParameters(<String, dynamic>{
      'filters': filter.toJson(),
    });
  }

  @override
  QueryPlatform orderBy(Iterable<List<dynamic>> orders) {
    final existing = List<List<dynamic>>.from(
      (parameters['orderBy'] as Iterable? ?? const []).map((e) => List<dynamic>.from(e as Iterable)),
    );
    for (final o in orders) {
      existing.add(List<dynamic>.from(o));
    }
    return _copyWithParameters(<String, dynamic>{
      'orderBy': existing,
    });
  }

  @override
  QueryPlatform limit(int limit) {
    return _copyWithParameters(<String, dynamic>{
      'limit': limit,
      'limitToLast': null,
    });
  }

  @override
  QueryPlatform limitToLast(int limit) {
    return _copyWithParameters(<String, dynamic>{
      'limit': null,
      'limitToLast': limit,
    });
  }

  @override
  QueryPlatform startAt(Iterable<dynamic> fields) {
    return _copyWithParameters(<String, dynamic>{
      'startAt': fields.toList(),
      'startAfter': null,
    });
  }

  @override
  QueryPlatform startAfter(Iterable<dynamic> fields) {
    return _copyWithParameters(<String, dynamic>{
      'startAt': null,
      'startAfter': fields.toList(),
    });
  }

  @override
  QueryPlatform endAt(Iterable<dynamic> fields) {
    return _copyWithParameters(<String, dynamic>{
      'endAt': fields.toList(),
      'endBefore': null,
    });
  }

  @override
  QueryPlatform endBefore(Iterable<dynamic> fields) {
    return _copyWithParameters(<String, dynamic>{
      'endAt': null,
      'endBefore': fields.toList(),
    });
  }

  @override
  QueryPlatform startAtDocument(Iterable<dynamic> orders, Iterable<dynamic> values) {
    return _copyWithParameters(<String, dynamic>{
      'orderBy': orders.toList(),
      'startAt': values.toList(),
      'startAfter': null,
    });
  }

  @override
  QueryPlatform startAfterDocument(Iterable<dynamic> orders, Iterable<dynamic> values) {
    return _copyWithParameters(<String, dynamic>{
      'orderBy': orders.toList(),
      'startAt': null,
      'startAfter': values.toList(),
    });
  }

  @override
  QueryPlatform endAtDocument(Iterable<dynamic> orders, Iterable<dynamic> values) {
    return _copyWithParameters(<String, dynamic>{
      'orderBy': orders.toList(),
      'endAt': values.toList(),
      'endBefore': null,
    });
  }

  @override
  QueryPlatform endBeforeDocument(Iterable<dynamic> orders, Iterable<dynamic> values) {
    return _copyWithParameters(<String, dynamic>{
      'orderBy': orders.toList(),
      'endAt': null,
      'endBefore': values.toList(),
    });
  }

  @override
  AggregateQueryPlatform count() {
    return PyricAggregateQuery(
      this,
      aggregateFields: [p.count()],
    );
  }

  @override
  AggregateQueryPlatform aggregate(
    AggregateField aggregateField1, [
    AggregateField? aggregateField2,
    AggregateField? aggregateField3,
    AggregateField? aggregateField4,
    AggregateField? aggregateField5,
    AggregateField? aggregateField6,
    AggregateField? aggregateField7,
    AggregateField? aggregateField8,
    AggregateField? aggregateField9,
    AggregateField? aggregateField10,
    AggregateField? aggregateField11,
    AggregateField? aggregateField12,
    AggregateField? aggregateField13,
    AggregateField? aggregateField14,
    AggregateField? aggregateField15,
    AggregateField? aggregateField16,
    AggregateField? aggregateField17,
    AggregateField? aggregateField18,
    AggregateField? aggregateField19,
    AggregateField? aggregateField20,
    AggregateField? aggregateField21,
    AggregateField? aggregateField22,
    AggregateField? aggregateField23,
    AggregateField? aggregateField24,
    AggregateField? aggregateField25,
    AggregateField? aggregateField26,
    AggregateField? aggregateField27,
    AggregateField? aggregateField28,
    AggregateField? aggregateField29,
    AggregateField? aggregateField30,
  ]) {
    final fields = <AggregateField>[
      aggregateField1,
      if (aggregateField2 != null) aggregateField2,
      if (aggregateField3 != null) aggregateField3,
      if (aggregateField4 != null) aggregateField4,
      if (aggregateField5 != null) aggregateField5,
      if (aggregateField6 != null) aggregateField6,
      if (aggregateField7 != null) aggregateField7,
      if (aggregateField8 != null) aggregateField8,
      if (aggregateField9 != null) aggregateField9,
      if (aggregateField10 != null) aggregateField10,
      if (aggregateField11 != null) aggregateField11,
      if (aggregateField12 != null) aggregateField12,
      if (aggregateField13 != null) aggregateField13,
      if (aggregateField14 != null) aggregateField14,
      if (aggregateField15 != null) aggregateField15,
      if (aggregateField16 != null) aggregateField16,
      if (aggregateField17 != null) aggregateField17,
      if (aggregateField18 != null) aggregateField18,
      if (aggregateField19 != null) aggregateField19,
      if (aggregateField20 != null) aggregateField20,
      if (aggregateField21 != null) aggregateField21,
      if (aggregateField22 != null) aggregateField22,
      if (aggregateField23 != null) aggregateField23,
      if (aggregateField24 != null) aggregateField24,
      if (aggregateField25 != null) aggregateField25,
      if (aggregateField26 != null) aggregateField26,
      if (aggregateField27 != null) aggregateField27,
      if (aggregateField28 != null) aggregateField28,
      if (aggregateField29 != null) aggregateField29,
      if (aggregateField30 != null) aggregateField30,
    ];
    return PyricAggregateQuery(this, aggregateFields: fields);
  }

  @override
  AggregateQueryPlatform sum(String field) {
    return PyricAggregateQuery(
      this,
      aggregateFields: [p.sum(field)],
    );
  }

  @override
  AggregateQueryPlatform average(String field) {
    return PyricAggregateQuery(
      this,
      aggregateFields: [p.average(field)],
    );
  }

  @override
  Future<QuerySnapshotPlatform> get([GetOptions options = const GetOptions()]) async {
    final target = compileTarget();
    final res = await _client.getDocs(target);
    return PyricQuerySnapshot.fromWire(firestore, path, res);
  }

  @override
  Stream<QuerySnapshotPlatform> snapshots({
    bool includeMetadataChanges = false,
    ListenSource listenSource = ListenSource.defaultSource,
  }) {
    final target = compileTarget();
    final stream = _client.subscribe(
      target,
      includeMetadataChanges: includeMetadataChanges,
      listenSource: listenSource.name,
    );
    List<DocumentSnapshotPlatform>? previousDocs;

    return stream.map((event) {
      final snap = PyricQuerySnapshot.fromWire(
        firestore,
        path,
        event,
        previousDocs: previousDocs,
      );
      previousDocs = snap.docs;
      return snap;
    });
  }
}
