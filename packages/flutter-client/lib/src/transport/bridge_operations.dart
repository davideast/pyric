import 'bridge_client.dart';
import 'codecs.dart';

/// Extension methods adding Firestore-specific RPC conveniences to [PyricBridgeClient].
extension PyricBridgeFirestoreOps on PyricBridgeClient {
  /// Reads a document snapshot via `getDoc`.
  Future<dynamic> getDoc(String path, {Map<String, dynamic>? actAs}) {
    return op('getDoc', {'path': path}, actAs: actAs);
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
    Map<String, dynamic>? actAs,
  }) {
    return op(
      'updateDoc',
      {
        'path': path,
        'data': encodeWriteData(data),
      },
      actAs: actAs,
    );
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
      return Map<String, dynamic>.from(res['data'] as Map);
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
  }) {
    return op(
      'txnCommit',
      {
        'reads': reads,
        'writes': writes,
      },
      actAs: actAs,
    );
  }
}
