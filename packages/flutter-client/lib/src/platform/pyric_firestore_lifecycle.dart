import 'dart:async';

import '../transport/exceptions.dart';
import 'pyric_offline_projection.dart';
import 'pyric_offline_query_evaluator.dart';

class ManagedFirestoreListener {
  final Map<String, dynamic> target;
  final bool includeMetadataChanges;
  final bool Function() hasDeliveredAny;
  final bool Function() hasDeliveredOnline;
  final void Function() suspendFromHost;
  final void Function() resumeOnHost;
  final void Function() deliverOfflineProjection;
  final void Function() cancelFromTerminate;

  const ManagedFirestoreListener({
    required this.target,
    required this.includeMetadataChanges,
    required this.hasDeliveredAny,
    required this.hasDeliveredOnline,
    required this.suspendFromHost,
    required this.resumeOnHost,
    required this.deliverOfflineProjection,
    required this.cancelFromTerminate,
  });
}

class _StagedOfflineWrite {
  final int stageId;
  final int writeId;
  final List<OfflineFirestoreMutation> mutations;
  final Future<dynamic> Function() sendOnline;
  final Completer<void> writeCompletion;

  const _StagedOfflineWrite({
    required this.stageId,
    required this.writeId,
    required this.mutations,
    required this.sendOnline,
    required this.writeCompletion,
  });
}

class _FirestorePersistenceStore {
  static final Map<String, Map<String, CachedFirestoreDoc>> _byNamespace = {};

  static String _key(String appName, String databaseId) =>
      '$appName::$databaseId';

  static Map<String, CachedFirestoreDoc> snapshot(
    String appName,
    String databaseId,
  ) {
    final map = _byNamespace[_key(appName, databaseId)];
    if (map == null) return <String, CachedFirestoreDoc>{};
    return Map<String, CachedFirestoreDoc>.from(map);
  }

  static void recordDoc(
    String appName,
    String databaseId,
    String path, {
    required bool exists,
    required Map<String, dynamic>? encodedFields,
  }) {
    final store = _byNamespace.putIfAbsent(
      _key(appName, databaseId),
      () => <String, CachedFirestoreDoc>{},
    );
    store[path] = CachedFirestoreDoc(
      exists: exists,
      encodedFields: encodedFields,
    );
  }

  static void removeDoc(String appName, String databaseId, String path) {
    final store = _byNamespace.putIfAbsent(
      _key(appName, databaseId),
      () => <String, CachedFirestoreDoc>{},
    );
    store[path] = const CachedFirestoreDoc(exists: false, encodedFields: null);
  }

  static void clear(String appName, String databaseId) {
    _byNamespace.remove(_key(appName, databaseId));
  }
}

class PyricFirestoreLifecycle {
  final String Function() _resolveAppName;
  final String Function() _resolveDatabaseId;

  bool _started = false;
  bool _terminated = false;
  bool _networkEnabled = true;
  int _nextId = 1;

  final Map<int, Completer<void>> _pendingWriteSettlements = {};
  final List<_StagedOfflineWrite> _queuedOfflineWrites = [];
  final Map<int, List<OfflineFirestoreMutation>> _stagedBatches = {};
  final Map<int, ManagedFirestoreListener> _managedListeners = {};
  final Set<StreamController<void>> _syncControllers = {};

  int _pendingListenerDeliveries = 0;
  bool _needsSyncNotification = false;

  PyricFirestoreLifecycle({
    required String Function() resolveAppName,
    required String Function() resolveDatabaseId,
  })  : _resolveAppName = resolveAppName,
        _resolveDatabaseId = resolveDatabaseId;

  String get _appName {
    try {
      return _resolveAppName();
    } catch (_) {
      return '[DEFAULT]';
    }
  }

  String get _databaseId => _resolveDatabaseId();

  bool get isNetworkEnabled => _networkEnabled;
  bool get isTerminated => _terminated;
  bool get isStarted => _started;

  void ensureActiveAndMarkStarted() {
    if (_terminated) {
      throw const PyricBridgeException(
        code: 'failed-precondition',
        message: 'The client has already been terminated.',
      );
    }
    _started = true;
  }

  /// Synchronously invokes [sendOnline] when online (preserving exact call-order
  /// frame sequencing), or stages [mutations] offline until [enableNetwork].
  Future<void> executeWrite({
    required List<OfflineFirestoreMutation> mutations,
    required Future<dynamic> Function() sendOnline,
  }) {
    ensureActiveAndMarkStarted();
    final writeId = _nextId++;
    final settlement = Completer<void>();
    _pendingWriteSettlements[writeId] = settlement;

    if (_networkEnabled) {
      final onlineFuture = sendOnline();
      return onlineFuture.then<void>(
        (_) {
          applyCommittedMutations(mutations);
          _settleWrite(writeId);
        },
        onError: (Object err, StackTrace st) {
          _settleWrite(writeId);
          Error.throwWithStackTrace(err, st);
        },
      );
    }

    final stageId = _nextId++;
    final writeCompletion = Completer<void>();
    _stagedBatches[stageId] = mutations;
    _queuedOfflineWrites.add(
      _StagedOfflineWrite(
        stageId: stageId,
        writeId: writeId,
        mutations: mutations,
        sendOnline: sendOnline,
        writeCompletion: writeCompletion,
      ),
    );

    final touchedPaths = mutations.map((m) => m.path).toSet();
    final listeners = _managedListeners.values.where((listener) {
      return touchedPaths.any(
        (p) => FirestoreOfflineProjection.targetMatchesPath(listener.target, p),
      );
    }).toList();
    for (final listener in listeners) {
      listener.deliverOfflineProjection();
    }
    return writeCompletion.future;
  }

  int beginTransactionWrite() {
    ensureActiveAndMarkStarted();
    final writeId = _nextId++;
    _pendingWriteSettlements[writeId] = Completer<void>();
    return writeId;
  }

  void finishTransactionWrite(
    int writeId, {
    List<OfflineFirestoreMutation>? committedMutations,
  }) {
    if (committedMutations != null) {
      applyCommittedMutations(committedMutations);
    }
    _settleWrite(writeId);
  }

  void _settleWrite(int writeId) {
    final completer = _pendingWriteSettlements.remove(writeId);
    if (completer != null && !completer.isCompleted) {
      completer.complete();
    }
  }

  Future<void> waitForPendingWrites() async {
    ensureActiveAndMarkStarted();
    if (_pendingWriteSettlements.isEmpty) {
      return;
    }
    final futures =
        _pendingWriteSettlements.values.map((c) => c.future).toList();
    await Future.wait(futures);
  }

  Future<void> disableNetwork() async {
    ensureActiveAndMarkStarted();
    if (!_networkEnabled) return;
    _networkEnabled = false;

    final listeners = _managedListeners.values.toList();
    for (final listener in listeners) {
      final shouldDeliverGap = !listener.hasDeliveredAny() ||
          (listener.includeMetadataChanges && listener.hasDeliveredOnline());
      listener.suspendFromHost();
      if (shouldDeliverGap) {
        listener.deliverOfflineProjection();
      }
    }
  }

  Future<void> enableNetwork() async {
    ensureActiveAndMarkStarted();
    final wasOffline = !_networkEnabled;
    _networkEnabled = true;

    final pending = List<_StagedOfflineWrite>.from(_queuedOfflineWrites);
    _queuedOfflineWrites.clear();

    for (final entry in pending) {
      try {
        await entry.sendOnline();
        applyCommittedMutations(entry.mutations);
        _stagedBatches.remove(entry.stageId);
        if (!entry.writeCompletion.isCompleted) {
          entry.writeCompletion.complete();
        }
      } catch (err, st) {
        _stagedBatches.remove(entry.stageId);
        if (!entry.writeCompletion.isCompleted) {
          entry.writeCompletion.completeError(err, st);
        }
      } finally {
        _settleWrite(entry.writeId);
      }
    }

    if (wasOffline && _networkEnabled && !_terminated) {
      final listeners = _managedListeners.values.toList();
      for (final listener in listeners) {
        listener.resumeOnHost();
      }
    }
  }

  Future<void> clearPersistence() async {
    final running = _started && !_terminated;
    if (running || _managedListeners.isNotEmpty) {
      throw const PyricBridgeException(
        code: 'failed-precondition',
        message:
            'Persistence cannot be cleared while the Firestore instance is running.',
      );
    }
    _stagedBatches.clear();
    _FirestorePersistenceStore.clear(_appName, _databaseId);
  }

  Future<void> terminate(Future<void> Function() disconnectBridge) async {
    if (_terminated) return;
    _terminated = true;

    final listeners = _managedListeners.values.toList();
    _managedListeners.clear();
    for (final listener in listeners) {
      listener.cancelFromTerminate();
    }

    final syncList = _syncControllers.toList();
    _syncControllers.clear();
    for (final ctrl in syncList) {
      if (!ctrl.isClosed) {
        await ctrl.close();
      }
    }

    final aborted = List<_StagedOfflineWrite>.from(_queuedOfflineWrites);
    _queuedOfflineWrites.clear();
    _stagedBatches.clear();
    for (final write in aborted) {
      if (!write.writeCompletion.isCompleted) {
        write.writeCompletion.completeError(
          const PyricBridgeException(
            code: 'aborted',
            message: 'The client has already been terminated.',
          ),
        );
      }
    }

    final writeIds = _pendingWriteSettlements.keys.toList();
    for (final id in writeIds) {
      _settleWrite(id);
    }

    await disconnectBridge();
  }

  int registerListener(ManagedFirestoreListener listener) {
    ensureActiveAndMarkStarted();
    final id = _nextId++;
    _managedListeners[id] = listener;
    return id;
  }

  void unregisterListener(int id) {
    _managedListeners.remove(id);
  }

  Stream<void> snapshotsInSync() {
    ensureActiveAndMarkStarted();
    late StreamController<void> controller;
    controller = StreamController<void>.broadcast(
      onListen: () {
        if (_terminated) return;
        _syncControllers.add(controller);
        if (_pendingListenerDeliveries == 0) {
          scheduleMicrotask(() {
            if (!_terminated &&
                _syncControllers.contains(controller) &&
                !controller.isClosed) {
              controller.add(null);
            }
          });
        } else {
          _needsSyncNotification = true;
        }
      },
      onCancel: () {
        _syncControllers.remove(controller);
      },
    );
    return controller.stream;
  }

  void runSnapshotDelivery(void Function() deliver) {
    _pendingListenerDeliveries += 1;
    try {
      deliver();
      _needsSyncNotification = true;
    } finally {
      _pendingListenerDeliveries -= 1;
      if (_pendingListenerDeliveries <= 0) {
        _pendingListenerDeliveries = 0;
        if (_needsSyncNotification) {
          _needsSyncNotification = false;
          final targets = _syncControllers.toList();
          scheduleMicrotask(() {
            for (final ctrl in targets) {
              if (!_terminated &&
                  _syncControllers.contains(ctrl) &&
                  !ctrl.isClosed) {
                ctrl.add(null);
              }
            }
          });
        }
      }
    }
  }

  void recordOnlineDoc(String path, dynamic wire) {
    if (wire is Map && wire.containsKey('exists') && wire['exists'] != true) {
      _FirestorePersistenceStore.recordDoc(
        _appName,
        _databaseId,
        path,
        exists: false,
        encodedFields: null,
      );
      return;
    }
    final fields = FirestoreOfflineProjection.extractWireEncodedFields(wire);
    if (fields == null) {
      _FirestorePersistenceStore.recordDoc(
        _appName,
        _databaseId,
        path,
        exists: false,
        encodedFields: null,
      );
      return;
    }
    _FirestorePersistenceStore.recordDoc(
      _appName,
      _databaseId,
      path,
      exists: true,
      encodedFields: fields,
    );
  }

  void recordOnlineQuery(dynamic wire) {
    if (wire is! Map || wire['docs'] is! List) return;
    for (final item in wire['docs'] as List) {
      if (item is Map && item['path'] is String) {
        recordOnlineDoc(item['path'] as String, item);
      }
    }
  }

  ProjectedFirestoreDoc readCachedDocument(String path) {
    final baseDocs = _FirestorePersistenceStore.snapshot(_appName, _databaseId);
    final projected = FirestoreOfflineProjection.projectDocument(
      path: path,
      baseRecord: baseDocs[path],
      stagedBatches: _stagedBatches.values.toList(),
    );
    if (!projected.known) {
      throw const PyricBridgeException(
        code: 'unavailable',
        message: 'Failed to get document from cache.',
      );
    }
    return projected;
  }

  ProjectedFirestoreDoc projectOfflineDocument(String path) {
    final baseDocs = _FirestorePersistenceStore.snapshot(_appName, _databaseId);
    return FirestoreOfflineProjection.projectDocument(
      path: path,
      baseRecord: baseDocs[path],
      stagedBatches: _stagedBatches.values.toList(),
    );
  }

  Map<String, dynamic> projectOfflineQuery(Map<String, dynamic> target) {
    final baseDocs = _FirestorePersistenceStore.snapshot(_appName, _databaseId);
    return FirestoreOfflineQueryEvaluator.projectQuery(
      target: target,
      baseDocs: baseDocs,
      stagedBatches: _stagedBatches.values.toList(),
    );
  }

  void applyCommittedMutations(List<OfflineFirestoreMutation> mutations) {
    for (final mutation in mutations) {
      if (mutation.kind == OfflineMutationKind.delete) {
        _FirestorePersistenceStore.removeDoc(
          _appName,
          _databaseId,
          mutation.path,
        );
        continue;
      }
      final baseDocs =
          _FirestorePersistenceStore.snapshot(_appName, _databaseId);
      final projected = FirestoreOfflineProjection.projectDocument(
        path: mutation.path,
        baseRecord: baseDocs[mutation.path],
        stagedBatches: [
          [mutation],
        ],
      );
      if (projected.exists) {
        _FirestorePersistenceStore.recordDoc(
          _appName,
          _databaseId,
          mutation.path,
          exists: true,
          encodedFields: projected.encodedFields,
        );
      }
    }
  }
}
