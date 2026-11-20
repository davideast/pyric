import 'dart:convert';

import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';

import '../transport/bridge_client.dart';
import '../transport/codecs.dart';
import 'mutation_serialization.dart';
import 'pyric_document_snapshot.dart';
import 'pyric_firestore_platform.dart';
import 'pyric_offline_projection.dart';

/// Concrete [TransactionPlatform] managing reads and writes within an atomic transaction.
class PyricTransaction extends TransactionPlatform {
  final FirebaseFirestorePlatform firestore;
  final List<Map<String, dynamic>> _reads = [];
  final List<Map<String, dynamic>> _writes = [];
  final List<OfflineFirestoreMutation> _mutations = [];

  PyricTransaction(this.firestore) : super();

  PyricFirestorePlatform get _firestorePlatform {
    final f = firestore;
    if (f is PyricFirestorePlatform) {
      return f;
    }
    throw StateError('Expected PyricFirestorePlatform, got ${f.runtimeType}');
  }

  PyricBridgeClient get _client => _firestorePlatform.bridgeClient;

  List<OfflineFirestoreMutation> get mutations =>
      List<OfflineFirestoreMutation>.unmodifiable(_mutations);

  @override
  Future<DocumentSnapshotPlatform> get(String documentPath) async {
    final f = _firestorePlatform;
    f.lifecycle.ensureActiveAndMarkStarted();
    if (!f.lifecycle.isNetworkEnabled) {
      throw const PyricBridgeException(
        code: 'unavailable',
        message: 'Transactions cannot be executed while the client is offline.',
      );
    }
    final res = await _client.getDoc(documentPath, actAs: f.effectiveAuthLens);
    f.lifecycle.recordOnlineDoc(documentPath, res);
    final snap = PyricDocumentSnapshot.fromWire(firestore, documentPath, res);
    Map<String, dynamic>? serializedData;
    if (snap.exists) {
      if (snap.rawWireData != null) {
        serializedData = snap.rawWireData;
      } else {
        serializedData = {'json': jsonEncode(encodeValue(snap.data()))};
      }
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
    _mutations.add(
      OfflineFirestoreMutation.set(documentPath, encoded, options: optMap),
    );
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
    _mutations.add(OfflineFirestoreMutation.update(documentPath, encoded));
    return this;
  }

  @override
  TransactionPlatform delete(String documentPath) {
    _writes.add({
      'method': 'delete',
      'path': documentPath,
    });
    _mutations.add(OfflineFirestoreMutation.delete(documentPath));
    return this;
  }

  /// Commits all transaction reads and writes via the Pyric bridge.
  Future<void> commit() async {
    final f = _firestorePlatform;
    await _client.txnCommit(_reads, _writes, actAs: f.effectiveAuthLens);
  }
}
