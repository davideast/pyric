import 'dart:convert';

import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import '../transport/bridge_client.dart';
import '../transport/codecs.dart';
import 'mutation_serialization.dart';
import 'pyric_firestore_platform.dart';

/// Concrete [TransactionPlatform] managing reads and writes within an atomic transaction.
class PyricTransaction extends TransactionPlatform {
  final FirebaseFirestorePlatform firestore;
  final List<Map<String, dynamic>> _reads = [];
  final List<Map<String, dynamic>> _writes = [];

  PyricTransaction(this.firestore) : super();

  PyricBridgeClient get _client {
    final f = firestore;
    if (f is PyricFirestorePlatform) {
      return f.bridgeClient;
    }
    throw StateError('Expected PyricFirestorePlatform, got ${f.runtimeType}');
  }

  @override
  Future<DocumentSnapshotPlatform> get(String documentPath) async {
    final snap = await firestore.doc(documentPath).get();
    Map<String, dynamic>? serializedData;
    if (snap.exists) {
      serializedData = {'json': jsonEncode(encodeValue(snap.data()))};
    }
    _reads.add({
      'path': documentPath,
      'data': serializedData,
    });
    return snap;
  }

  @override
  TransactionPlatform set(
    String documentPath,
    Map<String, dynamic> data, [
    SetOptions? options,
  ]) {
    final unwrapped = serializeSetData(data);
    final encoded = encodeWriteData(unwrapped);
    final optMap = serializeSetOptions(options);

    _writes.add({
      'method': 'set',
      'path': documentPath,
      'data': encoded,
      if (optMap != null) 'options': optMap,
    });
    return this;
  }

  @override
  TransactionPlatform update(
    String documentPath,
    Map<FieldPath, dynamic> data,
  ) {
    final stringMap = serializeUpdateData(data);
    final encoded = encodeWriteData(stringMap);

    _writes.add({
      'method': 'update',
      'path': documentPath,
      'data': encoded,
    });
    return this;
  }

  @override
  TransactionPlatform delete(String documentPath) {
    _writes.add({
      'method': 'delete',
      'path': documentPath,
    });
    return this;
  }

  /// Commits all transaction reads and writes via the Pyric bridge.
  Future<void> commit() async {
    final f = firestore as PyricFirestorePlatform;
    await _client.txnCommit(_reads, _writes, actAs: f.effectiveAuthLens);
  }
}
