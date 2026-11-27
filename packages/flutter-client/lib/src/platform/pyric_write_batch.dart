import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';

import '../transport/bridge_client.dart';
import '../transport/codecs.dart';
import 'mutation_serialization.dart';
import 'pyric_firestore_platform.dart';
import 'pyric_offline_projection.dart';

/// Concrete [WriteBatchPlatform] performing atomic multi-document mutations.
class PyricWriteBatch extends WriteBatchPlatform {
  final FirebaseFirestorePlatform firestore;
  final List<Map<String, dynamic>> _writes = [];
  final List<OfflineFirestoreMutation> _mutations = [];
  bool _committed = false;

  PyricWriteBatch(this.firestore) : super();

  PyricFirestorePlatform get _firestorePlatform {
    final f = firestore;
    if (f is PyricFirestorePlatform) {
      return f;
    }
    throw StateError('Expected PyricFirestorePlatform, got ${f.runtimeType}');
  }

  PyricBridgeClient get _client => _firestorePlatform.bridgeClient;

  void _assertNotCommitted() {
    if (_committed) {
      throw StateError('A write batch cannot be used after being committed.');
    }
  }

  @override
  void set(
    String documentPath,
    Map<String, dynamic> data, [
    SetOptions? options,
  ]) {
    _assertNotCommitted();
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
  }

  @override
  void update(
    String documentPath,
    Map<FieldPath, dynamic> data,
  ) {
    _assertNotCommitted();
    final stringMap = serializeUpdateData(data);
    final encoded = encodeWriteData(stringMap);
    final useFieldVectors = hasLiteralDotSegment(data.keys);

    if (useFieldVectors) {
      _writes.add({
        'method': 'update',
        'path': documentPath,
        'fields': serializeUpdateFieldDescriptors(data),
      });
      _mutations.add(
        OfflineFirestoreMutation.update(
          documentPath,
          encoded,
          updateSegments: serializeOfflineUpdateSegments(data),
        ),
      );
      return;
    }

    _writes.add({
      'method': 'update',
      'path': documentPath,
      'data': encoded,
    });
    _mutations.add(OfflineFirestoreMutation.update(documentPath, encoded));
  }

  @override
  void delete(String documentPath) {
    _assertNotCommitted();
    _writes.add({
      'method': 'delete',
      'path': documentPath,
    });
    _mutations.add(OfflineFirestoreMutation.delete(documentPath));
  }

  @override
  Future<void> commit() {
    _assertNotCommitted();
    _committed = true;
    final f = _firestorePlatform;
    final writesSnapshot = List<Map<String, dynamic>>.from(_writes);
    final mutationsSnapshot = List<OfflineFirestoreMutation>.from(_mutations);

    return f.lifecycle.executeWrite(
      mutations: mutationsSnapshot,
      sendOnline: () =>
          _client.batchCommit(writesSnapshot, actAs: f.effectiveAuthLens),
    );
  }
}
