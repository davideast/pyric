import 'bridge_client.dart';
import 'codecs.dart';

/// Extension methods adding Firestore-specific RPC conveniences to [PyricBridgeClient].
extension PyricBridgeFirestoreOps on PyricBridgeClient {
  /// Reads a document snapshot via `getDoc`.
  Future<dynamic> getDoc(
    String path, {
    Map<String, dynamic>? actAs,
    String? txnId,
  }) {
    final params = <String, dynamic>{
      'path': path,
      if (txnId != null && txnId.isNotEmpty) 'txnId': txnId,
    };
    return op('getDoc', params, actAs: actAs);
  }

  /// Reads query documents via `getDocs`.
  Future<dynamic> getDocs(
    Map<String, dynamic> source, {
    Map<String, dynamic>? actAs,
  }) {
    return op('getDocs', {'source': source}, actAs: actAs);
  }

  /// Writes document data via `setDoc`.
  Future<dynamic> setDoc(
    String path,
    Map<String, dynamic> data, {
    Map<String, dynamic>? options,
    Map<String, dynamic>? actAs,
  }) {
    final params = <String, dynamic>{
      'path': path,
      'data': encodeWriteData(data),
      if (options != null) 'options': options,
    };
    return op('setDoc', params, actAs: actAs);
  }

  /// Updates document fields via `updateDoc`.
  Future<dynamic> updateDoc(
    String path,
    Map<String, dynamic> data, {
    List<Map<String, dynamic>>? fields,
    Map<String, dynamic>? actAs,
  }) {
    final params = <String, dynamic>{
      'path': path,
      if (fields != null)
        'fields': fields
      else
        'data': encodeWriteData(data),
    };
    return op('updateDoc', params, actAs: actAs);
  }

  /// Deletes a document via `deleteDoc`.
  Future<dynamic> deleteDoc(String path, {Map<String, dynamic>? actAs}) {
    return op('deleteDoc', {'path': path}, actAs: actAs);
  }

  /// Creates a document with auto-ID under collection via `addDoc`.
  Future<dynamic> addDoc(
    String collectionPath,
    Map<String, dynamic> data, {
    Map<String, dynamic>? actAs,
  }) {
    return op(
      'addDoc',
      {
        'collectionPath': collectionPath,
        'data': encodeWriteData(data),
      },
      actAs: actAs,
    );
  }

  /// Counts matching documents via `count`.
  Future<int> count(
    Map<String, dynamic> source, {
    Map<String, dynamic>? actAs,
  }) async {
    final res = await op('count', {'source': source}, actAs: actAs);
    if (res is Map && res.containsKey('count')) {
      return (res['count'] as num).toInt();
    }
    return 0;
  }

  /// Performs server-side aggregations via `aggregate`.
  Future<Map<String, dynamic>> aggregate(
    Map<String, dynamic> source,
    Map<String, dynamic> spec, {
    Map<String, dynamic>? actAs,
  }) async {
    final res = await op(
      'aggregate',
      {
        'source': source,
        'spec': spec,
      },
      actAs: actAs,
    );
    if (res is Map && res.containsKey('data') && res['data'] is Map) {
      final out = Map<String, dynamic>.from(res['data'] as Map);
      final encoded = res['encodedData'];
      if (encoded is Map) {
        for (final entry in encoded.entries) {
          final key = entry.key.toString();
          final rawMarker = entry.value;
          if (rawMarker is Map && rawMarker['__type'] == 'number') {
            final tag = rawMarker['value'];
            if (tag == 'NaN') {
              out[key] = double.nan;
            } else if (tag == 'Infinity') {
              out[key] = double.infinity;
            } else if (tag == '-Infinity') {
              out[key] = double.negativeInfinity;
            } else if (tag == '-0') {
              out[key] = -0.0;
            }
          }
        }
      }
      return out;
    }
    return <String, dynamic>{};
  }

  /// Atomically commits a batch of write mutations via `batchCommit`.
  Future<dynamic> batchCommit(
    List<Map<String, dynamic>> writes, {
    Map<String, dynamic>? actAs,
  }) {
    return op('batchCommit', {'writes': writes}, actAs: actAs);
  }

  /// Commits an interactive transaction via `txnCommit`.
  Future<dynamic> txnCommit(
    List<Map<String, dynamic>> reads,
    List<Map<String, dynamic>> writes, {
    Map<String, dynamic>? actAs,
    String? txnId,
  }) {
    return op(
      'txnCommit',
      {
        'reads': reads,
        'writes': writes,
        if (txnId != null && txnId.isNotEmpty) 'txnId': txnId,
      },
      actAs: actAs,
    );
  }
}
