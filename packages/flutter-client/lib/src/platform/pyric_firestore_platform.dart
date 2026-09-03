import 'dart:async';

// ignore: depend_on_referenced_packages
import 'package:firebase_core/firebase_core.dart';
import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';

import '../transport/bridge_client.dart';
import 'pyric_collection_reference.dart';
import 'pyric_document_reference.dart';
import 'pyric_field_value_factory.dart';
import 'pyric_query.dart';
import 'pyric_transaction.dart';
import 'pyric_write_batch.dart';

/// Concrete [FirebaseFirestorePlatform] driving Firestore operations through the Pyric WebSocket bridge.
class PyricFirestorePlatform extends FirebaseFirestorePlatform {
  final PyricBridgeClient _bridgeClient;
  Settings _settings = const Settings();

  PyricFirestorePlatform({
    FirebaseApp? app,
    String? databaseId,
    PyricBridgeClient? bridgeClient,
  })  : _bridgeClient = bridgeClient ?? PyricBridgeClient(),
        super(appInstance: app, databaseChoice: databaseId);

  /// Access the underlying Pyric bridge client.
  PyricBridgeClient get bridgeClient => _bridgeClient;

  /// Registers [PyricFirestorePlatform] and [PyricFieldValueFactory] as default platforms.
  static void registerWith({PyricBridgeClient? bridgeClient}) {
    FirebaseFirestorePlatform.instance = PyricFirestorePlatform(
      bridgeClient: bridgeClient,
    );
    FieldValueFactoryPlatform.instance = PyricFieldValueFactory();
  }

  @override
  FirebaseFirestorePlatform delegateFor({
    required FirebaseApp app,
    required String databaseId,
  }) {
    return PyricFirestorePlatform(
      app: app,
      databaseId: databaseId,
      bridgeClient: _bridgeClient,
    );
  }

  @override
  Settings get settings => _settings;

  @override
  set settings(Settings settings) {
    _settings = settings;
  }

  @override
  DocumentReferencePlatform doc(String documentPath) {
    return PyricDocumentReference(this, documentPath);
  }

  @override
  CollectionReferencePlatform collection(String collectionPath) {
    return PyricCollectionReference(this, collectionPath);
  }

  @override
  QueryPlatform collectionGroup(String collectionPath) {
    return PyricQuery(this, collectionPath, isCollectionGroupQuery: true);
  }

  @override
  WriteBatchPlatform batch() {
    return PyricWriteBatch(this);
  }

  @override
  Future<T?> runTransaction<T>(
    TransactionHandler<T> transactionHandler, {
    Duration timeout = const Duration(seconds: 30),
    int maxAttempts = 5,
  }) async {
    int attempts = 0;
    while (true) {
      attempts++;
      final txn = PyricTransaction(this);
      try {
        final result = await transactionHandler(txn);
        await txn.commit();
        return result;
      } catch (e) {
        if (attempts >= maxAttempts) {
          rethrow;
        }
        if (e is PyricBridgeException &&
            (e.code == 'aborted' ||
                e.code == 'conflict' ||
                e.code == 'failed-precondition')) {
          continue;
        }
        rethrow;
      }
    }
  }

  @override
  Future<void> terminate() async {
    await _bridgeClient.disconnect();
  }

  @override
  Future<void> clearPersistence() {
    throw UnimplementedError('clearPersistence() is not yet implemented');
  }

  @override
  Future<void> enableNetwork() {
    throw UnimplementedError('enableNetwork() is not yet implemented');
  }

  @override
  Future<void> disableNetwork() {
    throw UnimplementedError('disableNetwork() is not yet implemented');
  }

  @override
  Future<void> waitForPendingWrites() {
    throw UnimplementedError('waitForPendingWrites() is not yet implemented');
  }

  @override
  Stream<void> snapshotsInSync() {
    throw UnimplementedError('snapshotsInSync() is not yet implemented');
  }
}
