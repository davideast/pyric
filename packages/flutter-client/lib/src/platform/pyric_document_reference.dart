import 'dart:async';

import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import '../transport/bridge_client.dart';
import '../transport/query_compiler.dart';
import 'mutation_serialization.dart';
import 'pyric_collection_reference.dart';
import 'pyric_document_snapshot.dart';
import 'pyric_firestore_platform.dart';
import 'pyric_resubscribing_stream.dart';

/// Concrete [DocumentReferencePlatform] pointing to a document in Pyric Firestore.
class PyricDocumentReference extends DocumentReferencePlatform {
  PyricDocumentReference(
    super.firestore,
    super.path,
  );

  PyricFirestorePlatform get _firestorePlatform {
    final f = firestore;
    if (f is PyricFirestorePlatform) {
      return f;
    }
    throw StateError('Expected PyricFirestorePlatform, got ${f.runtimeType}');
  }

  PyricBridgeClient get _client => _firestorePlatform.bridgeClient;

  @override
  CollectionReferencePlatform collection(String collectionPath) {
    return PyricCollectionReference(firestore, '$path/$collectionPath');
  }

  @override
  Future<void> delete() async {
    await _client.deleteDoc(path, actAs: _firestorePlatform.effectiveAuthLens);
  }

  @override
  Future<DocumentSnapshotPlatform> get([
    GetOptions options = const GetOptions(),
  ]) async {
    final res =
        await _client.getDoc(path, actAs: _firestorePlatform.effectiveAuthLens);
    return PyricDocumentSnapshot.fromWire(firestore, path, res);
  }

  @override
  Future<void> set(Map<String, dynamic> data, [SetOptions? options]) async {
    final unwrapped = serializeSetData(data);
    final optMap = serializeSetOptions(options);
    await _client.setDoc(
      path,
      unwrapped,
      options: optMap,
      actAs: _firestorePlatform.effectiveAuthLens,
    );
  }

  @override
  Future<void> update(Map<FieldPath, dynamic> data) async {
    final stringMap = serializeUpdateData(data);
    await _client.updateDoc(
      path,
      stringMap,
      actAs: _firestorePlatform.effectiveAuthLens,
    );
  }

  @override
  Stream<DocumentSnapshotPlatform> snapshots({
    bool includeMetadataChanges = false,
    ListenSource listenSource = ListenSource.defaultSource,
  }) {
    final target = QueryCompiler.compileDocumentTarget(path);
    final f = _firestorePlatform;

    return createResubscribingStream<DocumentSnapshotPlatform>(
      firestore: f,
      createSubscription: (actAs) => _client.subscribe(
        target,
        actAs: actAs,
        includeMetadataChanges: includeMetadataChanges,
        listenSource: listenSource.name,
      ),
      mapEvent: (event, _) => PyricDocumentSnapshot.fromWire(
        firestore,
        path,
        event,
      ),
    );
  }
}
