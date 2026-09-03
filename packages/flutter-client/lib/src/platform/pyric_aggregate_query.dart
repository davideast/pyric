import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart'
    as p;
import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';

import '../transport/bridge_client.dart';
import 'pyric_firestore_platform.dart';
import 'pyric_query.dart';

/// Concrete [AggregateQueryPlatform] executing server-side counts and aggregations.
class PyricAggregateQuery extends AggregateQueryPlatform {
  final List<AggregateField> aggregateFields;

  PyricAggregateQuery(
    super.query, {
    this.aggregateFields = const [],
  });

  PyricBridgeClient get _client {
    final platform = query.firestore;
    if (platform is PyricFirestorePlatform) {
      return platform.bridgeClient;
    }
    throw StateError('Expected PyricFirestorePlatform, got ${platform.runtimeType}');
  }

  @override
  AggregateQueryPlatform count() {
    return PyricAggregateQuery(
      query,
      aggregateFields: [...aggregateFields, p.count()],
    );
  }

  @override
  AggregateQueryPlatform sum(String field) {
    return PyricAggregateQuery(
      query,
      aggregateFields: [...aggregateFields, p.sum(field)],
    );
  }

  @override
  AggregateQueryPlatform average(String field) {
    return PyricAggregateQuery(
      query,
      aggregateFields: [...aggregateFields, p.average(field)],
    );
  }

  @override
  Future<AggregateQuerySnapshotPlatform> get({
    required AggregateSource source,
  }) async {
    final pyricQuery = query as PyricQuery;
    final target = pyricQuery.compileTarget();

    final isCountOnly = aggregateFields.isEmpty ||
        (aggregateFields.length == 1 && aggregateFields.first is p.count);

    if (isCountOnly) {
      final countVal = await _client.count(target);
      return AggregateQuerySnapshotPlatform(
        count: countVal,
        sum: const [],
        average: const [],
      );
    }

    final spec = <String, dynamic>{};
    for (final field in aggregateFields) {
      if (field is p.count) {
        spec['count'] = {'kind': 'count'};
      } else if (field is p.sum) {
        spec['sum_${field.field}'] = {'kind': 'sum', 'field': field.field};
      } else if (field is p.average) {
        spec['avg_${field.field}'] = {'kind': 'average', 'field': field.field};
      }
    }

    final data = await _client.aggregate(target, spec);

    int? countResult;
    if (data.containsKey('count')) {
      countResult = (data['count'] as num?)?.toInt();
    }

    final sums = <AggregateQueryResponse>[];
    final avgs = <AggregateQueryResponse>[];

    for (final field in aggregateFields) {
      if (field is p.sum) {
        final key = 'sum_${field.field}';
        final val = (data[key] as num?)?.toDouble();
        sums.add(AggregateQueryResponse(
          type: AggregateType.sum,
          field: field.field,
          value: val,
        ));
      } else if (field is p.average) {
        final key = 'avg_${field.field}';
        final val = (data[key] as num?)?.toDouble();
        avgs.add(AggregateQueryResponse(
          type: AggregateType.average,
          field: field.field,
          value: val,
        ));
      }
    }

    return AggregateQuerySnapshotPlatform(
      count: countResult,
      sum: sums,
      average: avgs,
    );
  }
}
