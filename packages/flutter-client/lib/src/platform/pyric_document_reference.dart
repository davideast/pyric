import 'dart:async';

import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import '../transport/bridge_client.dart';
import '../transport/query_compiler.dart';
import 'mutation_serialization.dart';
import 'pyric_collection_reference.dart';
import 'pyric_document_snapshot.dart';
import 'pyric_firestore_platform.dart';

/// Concrete [DocumentReferencePlatform] pointing to a document in Pyric Firestore.
class PyricDocumentReference extends DocumentReferencePlatform {
  PyricDocumentReference(
    super.firestore,
    super.path,
  );

  PyricBridgeClient get _client {
    final f = firestore;
    if (f is PyricFirestorePlatform) {
      return f.bridgeClient;
    }
    throw StateError('Expected PyricFirestorePlatform, got ${f.runtimeType}');
  }

  @override
  CollectionReferencePlatform collection(String collectionPath) {
    return PyricCollectionReference(firestore, '$path/$collectionPath');
  }

  @override
  Future<void> delete() async {
    await _client.deleteDoc(path);
  }

  @override
  Future<DocumentSnapshotPlatform> get([
    GetOptions options = const GetOptions(),
  ]) async {
    final res = await _client.getDoc(path);
    return PyricDocumentSnapshot.fromWire(firestore, path, res);
  }

  @override
  Future<void> set(Map<String, dynamic> data, [SetOptions? options]) async {
    final unwrapped = serializeSetData(data);
    final optMap = serializeSetOptions(options);
    await _client.setDoc(path, unwrapped, options: optMap);
  }

  @override
  Future<void> update(Map<FieldPath, dynamic> data) async {
    final stringMap = serializeUpdateData(data);
    await _client.updateDoc(path, stringMap);
  }

  @override
  Stream<DocumentSnapshotPlatform> snapshots({
    bool includeMetadataChanges = false,
    ListenSource listenSource = ListenSource.defaultSource,
  }) {
    final target = QueryCompiler.compileDocumentTarget(path);
    final stream = _client.subscribe(
      target,
      includeMetadataChanges: includeMetadataChanges,
      listenSource: listenSource.name,
    );
    return stream.map((event) => PyricDocumentSnapshot.fromWire(
          firestore,
          path,
          event,
        ));
  }
}
