import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import '../transport/bridge_client.dart';
import '../transport/codecs.dart';
import 'mutation_serialization.dart';
import 'pyric_firestore_platform.dart';

/// Concrete [WriteBatchPlatform] performing atomic multi-document mutations.
class PyricWriteBatch extends WriteBatchPlatform {
  final FirebaseFirestorePlatform firestore;
  final List<Map<String, dynamic>> _writes = [];
  bool _committed = false;

  PyricWriteBatch(this.firestore) : super();

  PyricBridgeClient get _client {
    final f = firestore;
    if (f is PyricFirestorePlatform) {
      return f.bridgeClient;
    }
    throw StateError('Expected PyricFirestorePlatform, got ${f.runtimeType}');
  }

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
  }

  @override
  void update(
    String documentPath,
    Map<FieldPath, dynamic> data,
  ) {
    _assertNotCommitted();
    final stringMap = serializeUpdateData(data);
    final encoded = encodeWriteData(stringMap);

    _writes.add({
      'method': 'update',
      'path': documentPath,
      'data': encoded,
    });
  }

  @override
  void delete(String documentPath) {
    _assertNotCommitted();
    _writes.add({
      'method': 'delete',
      'path': documentPath,
    });
  }

  @override
  Future<void> commit() async {
    _assertNotCommitted();
    _committed = true;
    await _client.batchCommit(_writes);
  }
}
