import 'dart:async';

import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';

import '../transport/bridge_client.dart';
import '../transport/codecs.dart';
import '../transport/query_compiler.dart';
import 'mutation_serialization.dart';
import 'pyric_collection_reference.dart';
import 'pyric_document_snapshot.dart';
import 'pyric_firestore_lifecycle.dart';
import 'pyric_firestore_platform.dart';
import 'pyric_offline_projection.dart';
import 'pyric_query_snapshot.dart';
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
    _firestorePlatform.lifecycle.ensureActiveAndMarkStarted();
    return PyricCollectionReference(firestore, '$path/$collectionPath');
  }

  @override
  Future<void> delete() {
    final f = _firestorePlatform;
    final lens = f.effectiveAuthLens;
    return f.lifecycle.executeWrite(
      mutations: [OfflineFirestoreMutation.delete(path)],
      sendOnline: () => _client.deleteDoc(path, actAs: lens),
    );
  }

  @override
  Future<DocumentSnapshotPlatform> get([
    GetOptions options = const GetOptions(),
  ]) async {
    final f = _firestorePlatform;
    f.lifecycle.ensureActiveAndMarkStarted();

    if (options.source == Source.cache) {
      final cached = f.lifecycle.readCachedDocument(path);
      return PyricDocumentSnapshot.fromWire(
        firestore,
        path,
        cached.wirePayload,
        isFromCache: true,
        hasPendingWrites: cached.hasPendingWrites,
      );
    }

    if (!f.lifecycle.isNetworkEnabled) {
      if (options.source == Source.server) {
        throw const PyricBridgeException(
          code: 'unavailable',
          message: 'Failed to get document because the client is offline.',
        );
      }
      final cached = f.lifecycle.readCachedDocument(path);
      return PyricDocumentSnapshot.fromWire(
        firestore,
        path,
        cached.wirePayload,
        isFromCache: true,
        hasPendingWrites: cached.hasPendingWrites,
      );
    }

    final lens = f.effectiveLens;
    final scope = PyricFirestoreLifecycle.authScopeForLens(lens);
    final res = await _client.getDoc(path, actAs: lens.toMap());
    f.lifecycle.recordOnlineDoc(path, res, authScope: scope);
    return PyricDocumentSnapshot.fromWire(firestore, path, res);
  }

  @override
  Future<void> set(Map<String, dynamic> data, [SetOptions? options]) {
    final f = _firestorePlatform;
    final unwrapped = serializeSetData(data);
    final optMap = serializeSetOptions(options);
    final encoded = encodeWriteData(unwrapped);
    final lens = f.effectiveAuthLens;

    return f.lifecycle.executeWrite(
      mutations: [
        OfflineFirestoreMutation.set(path, encoded, options: optMap),
      ],
      sendOnline: () => _client.setDoc(
        path,
        unwrapped,
        options: optMap,
        actAs: lens,
      ),
    );
  }

  @override
  Future<void> update(Map<FieldPath, dynamic> data) {
    final f = _firestorePlatform;
    final stringMap = serializeUpdateData(data);
    final encoded = encodeWriteData(stringMap);
    final useFieldVectors = hasLiteralDotSegment(data.keys);
    final fieldDescriptors =
        useFieldVectors ? serializeUpdateFieldDescriptors(data) : null;
    final offlineSegments =
        useFieldVectors ? serializeOfflineUpdateSegments(data) : null;
    final lens = f.effectiveAuthLens;

    return f.lifecycle.executeWrite(
      mutations: [
        OfflineFirestoreMutation.update(
          path,
          encoded,
          updateSegments: offlineSegments,
        ),
      ],
      sendOnline: () => _client.updateDoc(
        path,
        stringMap,
        fields: fieldDescriptors,
        actAs: lens,
      ),
    );
  }

  @override
  Stream<DocumentSnapshotPlatform> snapshots({
    bool includeMetadataChanges = false,
    ListenSource listenSource = ListenSource.defaultSource,
  }) {
    final target = QueryCompiler.compileDocumentTarget(path);
    final f = _firestorePlatform;
    f.lifecycle.ensureActiveAndMarkStarted();

    return createResubscribingStream<DocumentSnapshotPlatform>(
      firestore: f,
      target: target,
      includeMetadataChanges: includeMetadataChanges,
      createSubscription: (actAs) => _client.subscribe(
        target,
        actAs: actAs,
        includeMetadataChanges: includeMetadataChanges,
        listenSource: listenSource.name,
      ),
      recordOnlineEvent: (event) => f.lifecycle.recordOnlineDoc(path, event),
      mapEvent: (event, _) => PyricDocumentSnapshot.fromWire(
        firestore,
        path,
        event,
        isFromCache: listenSource == ListenSource.cache ||
            (event is Map && event['isFromCache'] == true),
        hasPendingWrites: event is Map && event['hasPendingWrites'] == true,
      ),
      buildOfflineProjection: (_) {
        final projected = f.lifecycle.projectOfflineDocument(path);
        return PyricDocumentSnapshot.fromWire(
          firestore,
          path,
          projected.wirePayload,
          isFromCache: true,
          hasPendingWrites: projected.hasPendingWrites,
        );
      },
      shouldSuppressMetadataOnly: (prev, next) =>
          prev.exists == next.exists &&
          PyricQuerySnapshot.mapsEqual(prev.data(), next.data()),
      mapGap: (lastEvent) => PyricDocumentSnapshot.fromWire(
        firestore,
        path,
        lastEvent,
        isFromCache: true,
      ),
    );
  }
}
