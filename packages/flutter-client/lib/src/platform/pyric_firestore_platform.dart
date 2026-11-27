import 'dart:async';

import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';
// ignore: depend_on_referenced_packages
import 'package:firebase_core/firebase_core.dart';
import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';

import '../auth/auth_lens.dart';
import '../auth/pyric_auth_credentials_provider.dart';
import '../transport/bridge_client.dart';
import 'pyric_collection_reference.dart';
import 'pyric_document_reference.dart';
import 'pyric_field_value_factory.dart';
import 'pyric_firestore_lifecycle.dart';
import 'pyric_query.dart';
import 'pyric_transaction.dart';
import 'pyric_write_batch.dart';

/// Concrete [FirebaseFirestorePlatform] driving Firestore operations through the Pyric WebSocket bridge.
class PyricFirestorePlatform extends FirebaseFirestorePlatform {
  final PyricBridgeClient _bridgeClient;
  PyricAuthCredentialsProvider? _credentialsProvider;
  Settings _settings = const Settings();
  late final PyricFirestoreLifecycle lifecycle;

  PyricFirestorePlatform({
    FirebaseApp? app,
    String? databaseId,
    PyricBridgeClient? bridgeClient,
    PyricAuthCredentialsProvider? credentialsProvider,
  })  : _bridgeClient = bridgeClient ?? PyricBridgeClient(),
        _credentialsProvider = credentialsProvider,
        super(appInstance: app, databaseChoice: databaseId) {
    lifecycle = PyricFirestoreLifecycle(
      resolveAppName: () => this.app.name,
      resolveDatabaseId: () => this.databaseId,
      resolveAuthScope: () =>
          PyricFirestoreLifecycle.authScopeForLens(effectiveLens),
    );
  }

  /// Access the underlying Pyric bridge client.
  PyricBridgeClient get bridgeClient => _bridgeClient;

  /// Access the credentials provider supplying auth lenses for operations.
  PyricAuthCredentialsProvider? get credentialsProvider {
    if (_credentialsProvider != null) return _credentialsProvider;
    try {
      final auth = FirebaseAuthPlatform.instance;
      if (auth is PyricAuthCredentialsProvider) {
        return auth as PyricAuthCredentialsProvider;
      }
    } catch (_) {}
    return null;
  }

  set credentialsProvider(PyricAuthCredentialsProvider? provider) {
    _credentialsProvider = provider;
  }

  /// Resolves the active [AuthLens] for stamping on operations and listeners.
  AuthLens get effectiveLens {
    final provider = credentialsProvider;
    if (provider != null) {
      return provider.currentAuthLens;
    }
    return AuthLens.anon;
  }

  /// Resolves the active [AuthLens] map for stamping on operations.
  Map<String, dynamic> get effectiveAuthLens => effectiveLens.toMap();

  /// Emits whenever the active [AuthLens] transitions.
  Stream<AuthLens> get authLensChanges {
    final provider = credentialsProvider;
    if (provider != null) {
      return provider.authLensChanges;
    }
    return const Stream.empty();
  }

  /// Registers [PyricFirestorePlatform] and [PyricFieldValueFactory] as default platforms.
  static void registerWith({
    PyricBridgeClient? bridgeClient,
    PyricAuthCredentialsProvider? credentialsProvider,
  }) {
    FirebaseFirestorePlatform.instance = PyricFirestorePlatform(
      bridgeClient: bridgeClient,
      credentialsProvider: credentialsProvider,
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
      credentialsProvider: _credentialsProvider,
    );
  }

  @override
  Settings get settings => _settings;

  @override
  set settings(Settings settings) {
    if (lifecycle.isTerminated) {
      throw const PyricBridgeException(
        code: 'failed-precondition',
        message: 'The client has already been terminated.',
      );
    }
    _settings = settings;
  }

  @override
  DocumentReferencePlatform doc(String documentPath) {
    lifecycle.ensureActiveAndMarkStarted();
    return PyricDocumentReference(this, documentPath);
  }

  @override
  CollectionReferencePlatform collection(String collectionPath) {
    lifecycle.ensureActiveAndMarkStarted();
    return PyricCollectionReference(this, collectionPath);
  }

  static int _nextTxnCounter = 0;

  @override
  QueryPlatform collectionGroup(String collectionPath) {
    if (collectionPath.isEmpty || collectionPath.contains('/')) {
      throw ArgumentError.value(
        collectionPath,
        'collectionPath',
        'Collection IDs must be non-empty and must not contain "/".',
      );
    }
    lifecycle.ensureActiveAndMarkStarted();
    return PyricQuery(this, collectionPath, isCollectionGroupQuery: true);
  }

  @override
  WriteBatchPlatform batch() {
    lifecycle.ensureActiveAndMarkStarted();
    return PyricWriteBatch(this);
  }

  @override
  Future<T?> runTransaction<T>(
    TransactionHandler<T> transactionHandler, {
    Duration timeout = const Duration(seconds: 30),
    int maxAttempts = 5,
  }) async {
    if (maxAttempts < 1) {
      throw ArgumentError.value(
        maxAttempts,
        'maxAttempts',
        'maxAttempts must be at least 1.',
      );
    }
    lifecycle.ensureActiveAndMarkStarted();
    if (!lifecycle.isNetworkEnabled) {
      throw const PyricBridgeException(
        code: 'unavailable',
        message: 'Transactions cannot be executed while the client is offline.',
      );
    }
    Future<T?> executeAttempts() async {
      int attempts = 0;
      while (true) {
        attempts++;
        _nextTxnCounter += 1;
        final attemptTxnId =
            'fl_txn_${DateTime.now().microsecondsSinceEpoch}_$_nextTxnCounter';
        final txn = PyricTransaction(this, txnId: attemptTxnId);
        int? writeId;
        var inCommit = false;
        try {
          final result = await transactionHandler(txn);
          writeId = lifecycle.beginTransactionWrite();
          inCommit = true;
          await txn.commit();
          lifecycle.finishTransactionWrite(
            writeId,
            committedMutations: txn.mutations,
          );
          return result;
        } catch (e) {
          if (writeId != null) {
            lifecycle.finishTransactionWrite(writeId);
          }
          if (attempts >= maxAttempts) {
            if (inCommit &&
                e is PyricBridgeException &&
                (e.code == 'aborted' || e.code == 'conflict')) {
              throw PyricBridgeException(
                code: 'failed-precondition',
                message: e.message,
                denialContext: e.denialContext,
                envelope: e.envelope,
              );
            }
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

    return executeAttempts().timeout(timeout);
  }

  @override
  Future<void> terminate() async {
    await lifecycle.terminate(() => _bridgeClient.disconnect());
  }

  @override
  Future<void> clearPersistence() {
    return lifecycle.clearPersistence();
  }

  @override
  Future<void> enableNetwork() {
    return lifecycle.enableNetwork();
  }

  @override
  Future<void> disableNetwork() {
    return lifecycle.disableNetwork();
  }

  @override
  Future<void> waitForPendingWrites() {
    return lifecycle.waitForPendingWrites();
  }

  @override
  Stream<void> snapshotsInSync() {
    return lifecycle.snapshotsInSync();
  }
}
