import 'dart:convert';

import '../transport/codecs.dart';

enum OfflineMutationKind { set, update, delete }

class OfflineFirestoreMutation {
  final OfflineMutationKind kind;
  final String path;
  final Map<String, dynamic>? encodedData;
  final List<MapEntry<List<String>, dynamic>>? updateSegments;
  final bool merge;
  final List<String>? mergeFields;

  const OfflineFirestoreMutation._({
    required this.kind,
    required this.path,
    this.encodedData,
    this.updateSegments,
    this.merge = false,
    this.mergeFields,
  });

  factory OfflineFirestoreMutation.set(
    String path,
    Map<String, dynamic> encodedData, {
    Map<String, dynamic>? options,
  }) {
    final merge = options != null && options['merge'] == true;
    List<String>? mergeFields;
    if (options != null && options['mergeFields'] is List) {
      mergeFields = (options['mergeFields'] as List)
          .map((item) => item.toString())
          .toList();
    }
    return OfflineFirestoreMutation._(
      kind: OfflineMutationKind.set,
      path: path,
      encodedData: _deepCopyMap(encodedData),
      merge: merge,
      mergeFields: mergeFields,
    );
  }

  factory OfflineFirestoreMutation.update(
    String path,
    Map<String, dynamic> encodedFields, {
    List<MapEntry<List<String>, dynamic>>? updateSegments,
  }) {
    return OfflineFirestoreMutation._(
      kind: OfflineMutationKind.update,
      path: path,
      encodedData: _deepCopyMap(encodedFields),
      updateSegments: updateSegments
          ?.map(
            (entry) => MapEntry(
              List<String>.unmodifiable(entry.key),
              _deepCopyValue(entry.value),
            ),
          )
          .toList(),
    );
  }

  factory OfflineFirestoreMutation.delete(String path) {
    return OfflineFirestoreMutation._(
      kind: OfflineMutationKind.delete,
      path: path,
    );
  }
}

class CachedFirestoreDoc {
  final bool exists;
  final Map<String, dynamic>? encodedFields;

  const CachedFirestoreDoc({
    required this.exists,
    required this.encodedFields,
  });
}

class ProjectedFirestoreDoc {
  final bool known;
  final bool exists;
  final bool hasPendingWrites;
  final Map<String, dynamic>? encodedFields;
  final Map<String, dynamic> wirePayload;

  const ProjectedFirestoreDoc({
    required this.known,
    required this.exists,
    required this.hasPendingWrites,
    required this.encodedFields,
    required this.wirePayload,
  });
}

Map<String, dynamic> _deepCopyMap(Map<dynamic, dynamic> input) {
  final out = <String, dynamic>{};
  for (final entry in input.entries) {
    out[entry.key.toString()] = _deepCopyValue(entry.value);
  }
  return out;
}

dynamic _deepCopyValue(dynamic value) {
  if (value is Map) return _deepCopyMap(value);
  if (value is List) return value.map(_deepCopyValue).toList();
  return value;
}

class FirestoreOfflineProjection {
  static const String _deletedMarker = '__pyric_offline_deleted__';

  static Map<String, dynamic>? extractWireEncodedFields(dynamic wire) {
    if (wire is! Map) return null;
    if (wire.containsKey('exists') && wire['exists'] != true) {
      return null;
    }
    final dynamic rawData = wire.containsKey('data') ? wire['data'] : wire;
    if (rawData == null) return null;
    if (rawData is Map && rawData['json'] is String) {
      final jsonStr = rawData['json'] as String;
      final allowEscaped = rawData['valueEncoding'] == docValueEncodingV1;
      try {
        final parsed = jsonDecode(jsonStr);
        if (parsed is Map) {
          return _unwrapEscapedWireMap(parsed, allowEscaped: allowEscaped);
        }
      } catch (_) {
        return <String, dynamic>{};
      }
    }
    if (rawData is Map) {
      return _deepCopyMap(rawData);
    }
    return <String, dynamic>{};
  }

  static Map<String, dynamic> _unwrapEscapedWireMap(
    Map<dynamic, dynamic> raw, {
    required bool allowEscaped,
  }) {
    if (allowEscaped &&
        raw['type'] == 'pyric/map/1.0' &&
        raw.length == 2 &&
        raw['fields'] is Map) {
      final inner = raw['fields'] as Map;
      final out = <String, dynamic>{};
      for (final entry in inner.entries) {
        out[entry.key.toString()] = _unwrapEscapedWireValue(
          entry.value,
          allowEscaped: allowEscaped,
        );
      }
      return out;
    }
    final out = <String, dynamic>{};
    for (final entry in raw.entries) {
      out[entry.key.toString()] = _unwrapEscapedWireValue(
        entry.value,
        allowEscaped: allowEscaped,
      );
    }
    return out;
  }

  static dynamic _unwrapEscapedWireValue(
    dynamic val, {
    required bool allowEscaped,
  }) {
    if (val is List) {
      return val
          .map((e) => _unwrapEscapedWireValue(e, allowEscaped: allowEscaped))
          .toList();
    }
    if (val is Map) {
      return _unwrapEscapedWireMap(val, allowEscaped: allowEscaped);
    }
    return val;
  }

  static bool targetMatchesPath(Map<String, dynamic> target, String path) {
    final ref = target['__ref'];
    if (ref == 'doc') {
      return target['path'] == path;
    }
    if (ref == 'collection') {
      final collPath = target['path'] as String? ?? '';
      final prefix = '$collPath/';
      if (!path.startsWith(prefix)) return false;
      final suffix = path.substring(prefix.length);
      return suffix.isNotEmpty && !suffix.contains('/');
    }
    if (ref == 'group') {
      final collectionId = target['collectionId'] as String? ?? '';
      final parts = path.split('/');
      return parts.length >= 2 &&
          parts.length.isEven &&
          parts[parts.length - 2] == collectionId;
    }
    if (ref == 'query' && target['source'] is Map) {
      return targetMatchesPath(
        Map<String, dynamic>.from(target['source'] as Map),
        path,
      );
    }
    return false;
  }

  static ProjectedFirestoreDoc projectDocument({
    required String path,
    required CachedFirestoreDoc? baseRecord,
    required List<List<OfflineFirestoreMutation>> stagedBatches,
  }) {
    var known = baseRecord != null;
    Map<String, dynamic>? current;
    if (baseRecord != null && baseRecord.exists) {
      current = _deepCopyMap(baseRecord.encodedFields ?? const {});
    }
    var hasPendingWrites = false;
    final nowSeconds = DateTime.now().millisecondsSinceEpoch ~/ 1000;

    for (final batch in stagedBatches) {
      for (final mutation in batch) {
        if (mutation.path != path) continue;
        known = true;
        hasPendingWrites = true;
        switch (mutation.kind) {
          case OfflineMutationKind.delete:
            current = null;
          case OfflineMutationKind.update:
            if (current == null) continue;
            final prior = _deepCopyMap(current);
            var updated = _deepCopyMap(current);
            final explicitSegments = mutation.updateSegments;
            if (explicitSegments != null) {
              for (final entry in explicitSegments) {
                final resolved = _resolveSentinelValue(
                  entry.value,
                  priorRoot: prior,
                  segments: entry.key,
                  nowSeconds: nowSeconds,
                  keepDeletes: true,
                );
                updated = _setField(updated, entry.key, resolved);
              }
            } else {
              final fields = mutation.encodedData ?? const <String, dynamic>{};
              for (final entry in fields.entries) {
                final segments = entry.key.split('.');
                final resolved = _resolveSentinelValue(
                  entry.value,
                  priorRoot: prior,
                  segments: segments,
                  nowSeconds: nowSeconds,
                  keepDeletes: true,
                );
                updated = _setField(updated, segments, resolved);
              }
            }
            current = updated;
          case OfflineMutationKind.set:
            final encoded = mutation.encodedData ?? const <String, dynamic>{};
            final isMerge = mutation.merge || mutation.mergeFields != null;
            final prior = (isMerge && current != null)
                ? _deepCopyMap(current)
                : null;
            final resolvedMap = _resolveMapSentinels(
              encoded,
              priorRoot: prior,
              prefix: const [],
              nowSeconds: nowSeconds,
              keepDeletes: isMerge,
            );
            if (mutation.merge) {
              if (current != null) {
                current = _mergeMaps(current, resolvedMap);
              } else {
                current = _stripDeletedFromMap(resolvedMap);
              }
            } else if (mutation.mergeFields != null) {
              var masked = current != null
                  ? _deepCopyMap(current)
                  : <String, dynamic>{};
              for (final maskKey in mutation.mergeFields!) {
                final segments = maskKey.split('.');
                final picked = readField(resolvedMap, segments);
                if (picked != null && !_isDeletedMarker(picked)) {
                  masked = _setField(
                    masked,
                    segments,
                    _stripDeletedFromValue(picked),
                  );
                } else {
                  masked = _setField(masked, segments, null);
                }
              }
              current = masked;
            } else {
              current = _stripDeletedFromMap(resolvedMap);
            }
        }
      }
    }

    final docId = path.split('/').last;
    final wire = <String, dynamic>{
      'id': docId,
      'path': path,
      'exists': current != null,
      'isFromCache': true,
      'hasPendingWrites': hasPendingWrites,
      if (current != null) 'data': current,
    };
    return ProjectedFirestoreDoc(
      known: known,
      exists: current != null,
      hasPendingWrites: hasPendingWrites,
      encodedFields: current,
      wirePayload: wire,
    );
  }

  static bool _isSentinel(dynamic val, String kind) {
    return val is Map && val['__sentinel'] == kind;
  }

  static bool _isDeletedMarker(dynamic val) {
    return _isSentinel(val, _deletedMarker) || _isSentinel(val, 'deleteField');
  }

  static bool isScalarMarker(Map<dynamic, dynamic> map) {
    final t = map['__type'];
    if (t is String) {
      return const {
        'timestamp',
        'latlng',
        'bytes',
        'reference',
        'vector',
        'number',
      }.contains(t);
    }
    final compat = map['type'];
    if (compat is String) {
      return const {
        'firestore/timestamp/1.0',
        'firestore/geoPoint/1.0',
        'firestore/bytes/1.0',
        'firestore/vectorValue/1.0',
      }.contains(compat);
    }
    return false;
  }

  static dynamic readField(
    Map<String, dynamic>? root,
    List<String> segments,
  ) {
    if (root == null || segments.isEmpty) return null;
    dynamic cur = root;
    for (final seg in segments) {
      if (cur is! Map || isScalarMarker(cur) || !cur.containsKey(seg)) {
        return null;
      }
      cur = cur[seg];
    }
    return cur;
  }

  static Map<String, dynamic> _setField(
    Map<String, dynamic> root,
    List<String> segments,
    dynamic value,
  ) {
    if (segments.isEmpty) return root;
    final out = _deepCopyMap(root);
    final head = segments.first;
    if (segments.length == 1) {
      if (value != null && !_isDeletedMarker(value)) {
        out[head] = _stripDeletedFromValue(value);
      } else {
        out.remove(head);
      }
      return out;
    }
    var child = <String, dynamic>{};
    final existing = out[head];
    if (existing is Map && !isScalarMarker(existing)) {
      child = _deepCopyMap(existing);
    }
    out[head] = _setField(child, segments.sublist(1), value);
    return out;
  }

  static Map<String, dynamic> _mergeMaps(
    Map<String, dynamic> base,
    Map<String, dynamic> incoming,
  ) {
    final out = _deepCopyMap(base);
    for (final entry in incoming.entries) {
      final key = entry.key;
      final val = entry.value;
      if (_isDeletedMarker(val)) {
        out.remove(key);
        continue;
      }
      if (val is Map && !isScalarMarker(val)) {
        if (val.isEmpty) {
          out[key] = <String, dynamic>{};
        } else if (out[key] is Map && !isScalarMarker(out[key] as Map)) {
          out[key] = _mergeMaps(
            _deepCopyMap(out[key] as Map),
            _deepCopyMap(val),
          );
        } else {
          out[key] = _stripDeletedFromMap(_deepCopyMap(val));
        }
      } else {
        out[key] = _stripDeletedFromValue(val);
      }
    }
    return out;
  }

  static Map<String, dynamic> _resolveMapSentinels(
    Map<String, dynamic> map, {
    required Map<String, dynamic>? priorRoot,
    required List<String> prefix,
    required int nowSeconds,
    required bool keepDeletes,
  }) {
    final out = <String, dynamic>{};
    for (final entry in map.entries) {
      final segs = <String>[...prefix, entry.key];
      out[entry.key] = _resolveSentinelValue(
        entry.value,
        priorRoot: priorRoot,
        segments: segs,
        nowSeconds: nowSeconds,
        keepDeletes: keepDeletes,
      );
    }
    return out;
  }

  static dynamic _resolveSentinelValue(
    dynamic value, {
    required Map<String, dynamic>? priorRoot,
    required List<String> segments,
    required int nowSeconds,
    required bool keepDeletes,
  }) {
    if (value is List) {
      return value
          .map(
            (item) => _resolveSentinelValue(
              item,
              priorRoot: priorRoot,
              segments: segments,
              nowSeconds: nowSeconds,
              keepDeletes: false,
            ),
          )
          .toList();
    }
    if (value is! Map) return value;
    if (value.containsKey('__sentinel')) {
      final kind = value['__sentinel'];
      if (kind == 'serverTimestamp') {
        return <String, dynamic>{
          '__type': 'timestamp',
          'seconds': nowSeconds,
          'nanos': 0,
        };
      }
      if (kind == 'deleteField') {
        return keepDeletes
            ? const <String, dynamic>{'__sentinel': _deletedMarker}
            : null;
      }
      if (kind == 'increment') {
        final delta = value['n'] as num? ?? 0;
        final priorVal = readField(priorRoot, segments);
        if (priorVal is num) {
          return priorVal + delta;
        }
        return delta;
      }
      if (kind == 'arrayUnion' || kind == 'arrayRemove') {
        final operands = (value['values'] as List? ?? const []).toList();
        final priorVal = readField(priorRoot, segments);
        final baseList = priorVal is List
            ? List<dynamic>.from(priorVal.map(_deepCopyValue))
            : <dynamic>[];
        if (kind == 'arrayUnion') {
          for (final item in operands) {
            if (!baseList.any((existing) => wireValuesEqual(existing, item))) {
              baseList.add(_deepCopyValue(item));
            }
          }
        } else {
          baseList.removeWhere(
            (existing) =>
                operands.any((target) => wireValuesEqual(existing, target)),
          );
        }
        return baseList;
      }
    }
    if (isScalarMarker(value)) {
      return _deepCopyMap(value);
    }
    return _resolveMapSentinels(
      _deepCopyMap(value),
      priorRoot: priorRoot,
      prefix: segments,
      nowSeconds: nowSeconds,
      keepDeletes: keepDeletes,
    );
  }

  static Map<String, dynamic> _stripDeletedFromMap(Map<String, dynamic> map) {
    final out = <String, dynamic>{};
    for (final entry in map.entries) {
      if (!_isDeletedMarker(entry.value)) {
        out[entry.key] = _stripDeletedFromValue(entry.value);
      }
    }
    return out;
  }

  static dynamic _stripDeletedFromValue(dynamic value) {
    if (value is List) return value.map(_stripDeletedFromValue).toList();
    if (value is Map && !isScalarMarker(value)) {
      return _stripDeletedFromMap(_deepCopyMap(value));
    }
    return _deepCopyValue(value);
  }

  static bool wireValuesEqual(dynamic lhs, dynamic rhs) {
    if (identical(lhs, rhs)) return true;
    if (lhs is num && rhs is num) {
      if (lhs.isNaN || rhs.isNaN) return false;
      return lhs == rhs;
    }
    if (lhs is List && rhs is List) {
      if (lhs.length != rhs.length) return false;
      for (var i = 0; i < lhs.length; i++) {
        if (!wireValuesEqual(lhs[i], rhs[i])) return false;
      }
      return true;
    }
    if (lhs is Map && rhs is Map) {
      if (lhs.length != rhs.length) return false;
      for (final key in lhs.keys) {
        if (!rhs.containsKey(key) || !wireValuesEqual(lhs[key], rhs[key])) {
          return false;
        }
      }
      return true;
    }
    return lhs == rhs;
  }
}
