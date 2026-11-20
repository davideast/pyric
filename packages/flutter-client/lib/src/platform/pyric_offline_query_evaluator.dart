import 'pyric_offline_projection.dart';

class FirestoreOfflineQueryEvaluator {
  static Map<String, dynamic> projectQuery({
    required Map<String, dynamic> target,
    required Map<String, CachedFirestoreDoc> baseDocs,
    required List<List<OfflineFirestoreMutation>> stagedBatches,
  }) {
    final candidatePaths = <String>{...baseDocs.keys};
    for (final batch in stagedBatches) {
      for (final mutation in batch) {
        candidatePaths.add(mutation.path);
      }
    }
    final sortedPaths = candidatePaths.toList()..sort();
    final projectedDocs = <(String, ProjectedFirestoreDoc)>[];
    for (final path in sortedPaths) {
      if (!FirestoreOfflineProjection.targetMatchesPath(target, path)) {
        continue;
      }
      final projected = FirestoreOfflineProjection.projectDocument(
        path: path,
        baseRecord: baseDocs[path],
        stagedBatches: stagedBatches,
      );
      if (projected.exists) {
        projectedDocs.add((path, projected));
      }
    }

    final filtered = applyQueryConstraints(target, projectedDocs);
    final anyPending = filtered.any((entry) => entry.$2.hasPendingWrites);
    return <String, dynamic>{
      'docs': filtered.map((entry) => entry.$2.wirePayload).toList(),
      'isFromCache': true,
      'hasPendingWrites': anyPending,
    };
  }

  static List<(String, ProjectedFirestoreDoc)> applyQueryConstraints(
    Map<String, dynamic> target,
    List<(String, ProjectedFirestoreDoc)> candidates,
  ) {
    if (target['__ref'] != 'query') {
      return candidates;
    }
    final rawConstraints = target['constraints'];
    if (rawConstraints is! List || rawConstraints.isEmpty) {
      return candidates;
    }

    final filters = <Map<String, dynamic>>[];
    final orders = <(String, bool)>[];
    int? limitCount;
    var limitToLast = false;
    (List<dynamic>, bool)? startCursor;
    (List<dynamic>, bool)? endCursor;

    for (final raw in rawConstraints) {
      if (raw is! Map) continue;
      final c = Map<String, dynamic>.from(raw);
      final kind = c['kind'] as String?;
      switch (kind) {
        case 'where':
        case 'and':
        case 'or':
          filters.add(c);
        case 'orderBy':
          final field = c['field'] as String? ?? '__name__';
          final desc = c['direction'] == 'desc';
          orders.add((field, desc));
        case 'limit':
          limitCount = (c['n'] as num?)?.toInt();
          limitToLast = false;
        case 'limitToLast':
          limitCount = (c['n'] as num?)?.toInt();
          limitToLast = true;
        case 'startAt':
          startCursor = (List<dynamic>.from(c['values'] as List? ?? const []), true);
        case 'startAfter':
          startCursor = (List<dynamic>.from(c['values'] as List? ?? const []), false);
        case 'endAt':
          endCursor = (List<dynamic>.from(c['values'] as List? ?? const []), true);
        case 'endBefore':
          endCursor = (List<dynamic>.from(c['values'] as List? ?? const []), false);
      }
    }

    var result = candidates.where((entry) {
      for (final clause in orders) {
        if (clause.$1 != '__name__') {
          if (!_hasField(clause.$1, entry.$1, entry.$2.encodedFields)) {
            return false;
          }
        }
      }
      return filters.every(
        (f) => _matchesFilter(f, entry.$1, entry.$2.encodedFields),
      );
    }).toList();

    final effectiveOrders = List<(String, bool)>.from(orders);
    if (!effectiveOrders.any((o) => o.$1 == '__name__')) {
      final tieDesc = effectiveOrders.isNotEmpty && effectiveOrders.last.$2;
      effectiveOrders.add(('__name__', tieDesc));
    }

    result.sort((lhs, rhs) => _compareEntries(lhs, rhs, effectiveOrders));

    if (startCursor != null) {
      final (values, inclusive) = startCursor;
      result = result.where((entry) {
        final cmp = _compareToCursor(entry, values, effectiveOrders);
        return inclusive ? cmp >= 0 : cmp > 0;
      }).toList();
    }
    if (endCursor != null) {
      final (values, inclusive) = endCursor;
      result = result.where((entry) {
        final cmp = _compareToCursor(entry, values, effectiveOrders);
        return inclusive ? cmp <= 0 : cmp < 0;
      }).toList();
    }
    if (limitCount != null && limitCount >= 0 && result.length > limitCount) {
      if (limitToLast) {
        result = result.sublist(result.length - limitCount);
      } else {
        result = result.sublist(0, limitCount);
      }
    }
    return result;
  }

  static bool _hasField(
    String field,
    String path,
    Map<String, dynamic>? fields,
  ) {
    if (field == '__name__') return true;
    if (fields == null) return false;
    final segments = field.split('.');
    dynamic cur = fields;
    for (var i = 0; i < segments.length; i++) {
      if (cur is! Map || FirestoreOfflineProjection.isScalarMarker(cur)) {
        return false;
      }
      if (!cur.containsKey(segments[i])) return false;
      cur = cur[segments[i]];
    }
    return true;
  }

  static dynamic _fieldValue(
    String field,
    String path,
    Map<String, dynamic>? fields,
  ) {
    if (field == '__name__') {
      return path.split('/').last;
    }
    return FirestoreOfflineProjection.readField(fields, field.split('.'));
  }

  static bool _matchesFilter(
    Map<String, dynamic> filter,
    String path,
    Map<String, dynamic>? fields,
  ) {
    final kind = filter['kind'];
    if (kind == 'and') {
      final children = filter['filters'] as List? ?? const [];
      return children.every(
        (c) =>
            c is Map &&
            _matchesFilter(Map<String, dynamic>.from(c), path, fields),
      );
    }
    if (kind == 'or') {
      final children = filter['filters'] as List? ?? const [];
      return children.any(
        (c) =>
            c is Map &&
            _matchesFilter(Map<String, dynamic>.from(c), path, fields),
      );
    }
    if (kind != 'where') return true;

    final field = filter['field'] as String? ?? '';
    final op = filter['op'] as String? ?? '==';
    final target = filter['value'];
    if (!_hasField(field, path, fields)) {
      return false;
    }
    final actual = _fieldValue(field, path, fields);

    switch (op) {
      case '==':
        return FirestoreOfflineProjection.wireValuesEqual(actual, target);
      case '!=':
        return !FirestoreOfflineProjection.wireValuesEqual(actual, target);
      case '<':
        return _sameDomain(actual, target) && _compareValues(actual, target) < 0;
      case '<=':
        return _sameDomain(actual, target) &&
            _compareValues(actual, target) <= 0;
      case '>':
        return _sameDomain(actual, target) && _compareValues(actual, target) > 0;
      case '>=':
        return _sameDomain(actual, target) &&
            _compareValues(actual, target) >= 0;
      case 'array-contains':
        if (actual is! List) return false;
        return actual.any(
          (item) => FirestoreOfflineProjection.wireValuesEqual(item, target),
        );
      case 'in':
        if (target is! List) return false;
        return target.any(
          (item) => FirestoreOfflineProjection.wireValuesEqual(actual, item),
        );
      case 'not-in':
        if (target is! List) return false;
        return !target.any(
          (item) => FirestoreOfflineProjection.wireValuesEqual(actual, item),
        );
      case 'array-contains-any':
        if (actual is! List || target is! List) return false;
        return actual.any(
          (item) => target.any(
            (candidate) =>
                FirestoreOfflineProjection.wireValuesEqual(item, candidate),
          ),
        );
      default:
        return false;
    }
  }

  static int _compareEntries(
    (String, ProjectedFirestoreDoc) lhs,
    (String, ProjectedFirestoreDoc) rhs,
    List<(String, bool)> orders,
  ) {
    for (final (field, desc) in orders) {
      final lv = _fieldValue(field, lhs.$1, lhs.$2.encodedFields);
      final rv = _fieldValue(field, rhs.$1, rhs.$2.encodedFields);
      final cmp = _compareValues(lv, rv);
      if (cmp != 0) {
        return desc ? -cmp : cmp;
      }
    }
    return 0;
  }

  static int _compareToCursor(
    (String, ProjectedFirestoreDoc) entry,
    List<dynamic> cursor,
    List<(String, bool)> orders,
  ) {
    final limit = cursor.length < orders.length ? cursor.length : orders.length;
    for (var i = 0; i < limit; i++) {
      final (field, desc) = orders[i];
      final actual = _fieldValue(field, entry.$1, entry.$2.encodedFields);
      final cmp = _compareValues(actual, cursor[i]);
      if (cmp != 0) {
        return desc ? -cmp : cmp;
      }
    }
    return 0;
  }

  static int _typeRank(dynamic val) {
    if (val == null) return 0;
    if (val is bool) return 1;
    if (val is num) return 2;
    if (val is String) return 4;
    if (val is List) return 8;
    if (val is Map) {
      final marker = val['__type'] ?? val['type'];
      switch (marker) {
        case 'number':
          return 2;
        case 'timestamp':
        case 'firestore/timestamp/1.0':
          return 3;
        case 'bytes':
        case 'firestore/bytes/1.0':
          return 5;
        case 'reference':
          return 6;
        case 'latlng':
        case 'firestore/geoPoint/1.0':
          return 7;
        default:
          return 9;
      }
    }
    return 9;
  }

  static bool _sameDomain(dynamic a, dynamic b) =>
      _typeRank(a) == _typeRank(b);

  static int _compareValues(dynamic a, dynamic b) {
    final ra = _typeRank(a);
    final rb = _typeRank(b);
    if (ra != rb) return ra.compareTo(rb);
    switch (ra) {
      case 0:
        return 0;
      case 1:
        final ba = a == true ? 1 : 0;
        final bb = b == true ? 1 : 0;
        return ba.compareTo(bb);
      case 2:
        final na = (a is num) ? a.toDouble() : 0.0;
        final nb = (b is num) ? b.toDouble() : 0.0;
        if (na.isNaN && nb.isNaN) return 0;
        if (na.isNaN) return -1;
        if (nb.isNaN) return 1;
        return na.compareTo(nb);
      case 3:
        final sa = ((a as Map)['seconds'] as num? ?? 0).toInt();
        final sb = ((b as Map)['seconds'] as num? ?? 0).toInt();
        if (sa != sb) return sa.compareTo(sb);
        final na = (a['nanos'] as num? ?? a['nanoseconds'] as num? ?? 0).toInt();
        final nb = (b['nanos'] as num? ?? b['nanoseconds'] as num? ?? 0).toInt();
        return na.compareTo(nb);
      case 4:
        return (a as String).compareTo(b as String);
      case 6:
        return ((a as Map)['path'] as String? ?? '')
            .compareTo((b as Map)['path'] as String? ?? '');
      case 7:
        final la = ((a as Map)['lat'] as num? ?? a['latitude'] as num? ?? 0)
            .toDouble();
        final lb = ((b as Map)['lat'] as num? ?? b['latitude'] as num? ?? 0)
            .toDouble();
        if (la != lb) return la.compareTo(lb);
        final ga = ((a)['lng'] as num? ?? a['longitude'] as num? ?? 0)
            .toDouble();
        final gb = ((b)['lng'] as num? ?? b['longitude'] as num? ?? 0)
            .toDouble();
        return ga.compareTo(gb);
      default:
        return a.toString().compareTo(b.toString());
    }
  }
}
