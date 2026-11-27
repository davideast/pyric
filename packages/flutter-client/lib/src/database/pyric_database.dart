import 'dart:async';

import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';
// ignore: depend_on_referenced_packages
import 'package:firebase_core/firebase_core.dart';

import '../auth/auth_lens.dart';
import '../auth/pyric_auth_credentials_provider.dart';
import '../transport/bridge_client.dart';
import 'connection_info.dart';
import 'instance_name.dart';
import 'pyric_database_reference.dart';
import 'rtdb_view_coordinator.dart';

/// Entry point for the Pyric Realtime Database client SDK.
class PyricDatabase {
  static PyricDatabase? _defaultInstance;
  static final Map<String, PyricDatabase> _urlInstances = {};

  final PyricBridgeClient _bridgeClient;
  late final ConnectionInfo _connectionInfo = ConnectionInfo(_bridgeClient);
  late final RtdbViewCoordinator viewCoordinator = RtdbViewCoordinator(this);
  PyricAuthCredentialsProvider? _credentialsProvider;
  StreamController<AuthLens>? _dynamicLensController;
  StreamSubscription<AuthLens>? _providerLensSub;
  PyricAuthCredentialsProvider? _boundProvider;
  final FirebaseApp? app;
  final String? databaseURL;

  PyricDatabase({
    this.app,
    this.databaseURL,
    PyricBridgeClient? bridgeClient,
    PyricAuthCredentialsProvider? credentialsProvider,
  })  : _bridgeClient = bridgeClient ?? PyricBridgeClient(),
        _credentialsProvider = credentialsProvider;

  /// Returns the default [PyricDatabase] instance bound to the active bridge connection.
  static PyricDatabase get instance {
    return _defaultInstance ??= PyricDatabase();
  }

  /// Returns an isolated [PyricDatabase] instance targeting a specific [databaseURL].
  static PyricDatabase instanceFor({
    FirebaseApp? app,
    required String databaseURL,
    PyricBridgeClient? bridgeClient,
    PyricAuthCredentialsProvider? credentialsProvider,
  }) {
    final key = '${app?.name ?? '[DEFAULT]'}|$databaseURL';
    final existing = _urlInstances[key];
    if (existing != null &&
        bridgeClient == null &&
        credentialsProvider == null) {
      return existing;
    }
    final db = PyricDatabase(
      app: app,
      databaseURL: databaseURL,
      bridgeClient: bridgeClient ?? _defaultInstance?.bridgeClient,
      credentialsProvider:
          credentialsProvider ?? _defaultInstance?.credentialsProvider,
    );
    _urlInstances[key] = db;
    return db;
  }

  /// Registers default [PyricDatabase] instance with shared bridge and credentials provider.
  static void registerWith({
    PyricBridgeClient? bridgeClient,
    PyricAuthCredentialsProvider? credentialsProvider,
  }) {
    _defaultInstance = PyricDatabase(
      bridgeClient: bridgeClient,
      credentialsProvider: credentialsProvider,
    );
    _urlInstances.clear();
  }

  /// Access the underlying Pyric bridge client.
  PyricBridgeClient get bridgeClient => _bridgeClient;

  /// Serves the paths under `/.info` for this database.
  ConnectionInfo get connectionInfo => _connectionInfo;

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
    _rebindDynamicLensProvider(emitCurrent: true);
  }

  void _rebindDynamicLensProvider({bool emitCurrent = false}) {
    final controller = _dynamicLensController;
    if (controller == null || controller.isClosed || !controller.hasListener) {
      return;
    }
    final provider = credentialsProvider;
    if (!identical(provider, _boundProvider)) {
      _providerLensSub?.cancel();
      _providerLensSub = null;
      _boundProvider = provider;
      if (provider != null) {
        _providerLensSub = provider.authLensChanges.listen(
          (lens) {
            if (!controller.isClosed) {
              controller.add(lens);
            }
          },
          onError: (Object _, StackTrace __) {},
        );
      }
    }
    if (emitCurrent && !controller.isClosed) {
      controller.add(effectiveLens);
    }
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

  /// Emits whenever the active [AuthLens] transitions, including providers attached lazily.
  Stream<AuthLens> get authLensChanges {
    final controller = _dynamicLensController ??= StreamController<AuthLens>.broadcast(
      sync: true,
      onListen: () => _rebindDynamicLensProvider(),
      onCancel: () {
        _providerLensSub?.cancel();
        _providerLensSub = null;
        _boundProvider = null;
      },
    );
    return controller.stream;
  }

  /// Returns a [PyricDatabaseReference] pointing to the specified [path], or root if omitted.
  PyricDatabaseReference ref([String? path]) {
    final normalized = _normalizePath(path);
    return PyricDatabaseReference(this, normalized);
  }

  static String _normalizePath(String? path) {
    if (path == null || path.trim().isEmpty) return '/';
    final segments = path.split('/').where((s) => s.isNotEmpty).toList();
    if (segments.isEmpty) return '/';
    return '/${segments.join('/')}';
  }

  /// Suspends the Realtime Database connection to the Pyric worker and triggers queued disconnect ops.
  Future<void> goOffline() {
    final future = op('rtdb.goOffline', const {});
    _connectionInfo.setOnline(false);
    return future;
  }

  /// Resumes the Realtime Database connection to the Pyric worker.
  Future<void> goOnline() {
    final future = op('rtdb.goOnline', const {});
    _connectionInfo.setOnline(true);
    return future;
  }

  /// Wire `instance` selector derived from [databaseURL] (or [app] options),
  /// or `null` when targeting the default instance.
  String? get wireInstance {
    final effectiveUrl = databaseURL ?? app?.options.databaseURL;
    return resolveDatabaseInstanceName(
      effectiveUrl,
      projectId: app?.options.projectId,
    );
  }

  static bool _isRecoverableRtdbDenial(Object err) {
    if (err is! PyricBridgeException) return false;
    if (err.denialContext != null) return true;
    final code = err.code.trim().toLowerCase().replaceAll('_', '-');
    return code == 'permission-denied' ||
        code == 'database/permission-denied' ||
        code == 'unauthenticated' ||
        code == 'database/unauthenticated';
  }

  /// Dispatches an RTDB worker operation stamped with the active [AuthLens]
  /// (or an explicit pinned [actAs] map) and optional non-default wire `instance`.
  Future<dynamic> op(
    String method,
    Map<String, dynamic> params, {
    Map<String, dynamic>? actAs,
  }) {
    final instance = wireInstance;
    final payload = instance == null
        ? params
        : <String, dynamic>{...params, 'instance': instance};
    return _bridgeClient.op(
      method,
      payload,
      actAs: actAs ?? effectiveAuthLens,
    );
  }

  /// Establishes an RTDB real-time subscription that automatically resubscribes upon [AuthLens] change.
  ///
  /// A path under `/.info` is served by [connectionInfo] and never reaches the host.
  Stream<dynamic> subscribeRtdb(
    String path, {
    Map<String, dynamic>? querySpec,
    void Function(AuthLens nextLens)? onLensChange,
  }) {
    if (isInfoPath(path)) return _connectionInfo.watch(path);
    late StreamController<dynamic> controller;
    StreamSubscription<dynamic>? bridgeSub;
    StreamSubscription<AuthLens>? authLensSub;
    StreamSubscription<BridgeConnectionState>? bridgeStateSub;
    var listenGeneration = 0;
    AuthLens? activeLens;

    void closeFromBridge() {
      if (controller.isClosed) return;
      listenGeneration++;
      final prevBridgeSub = bridgeSub;
      bridgeSub = null;
      final prevAuthLensSub = authLensSub;
      authLensSub = null;
      final prevStateSub = bridgeStateSub;
      bridgeStateSub = null;
      activeLens = null;
      prevBridgeSub?.cancel();
      prevAuthLensSub?.cancel();
      prevStateSub?.cancel();
      controller.close();
    }

    void startListening(AuthLens lens, int generation) {
      if (generation != listenGeneration || controller.isClosed) return;
      activeLens = lens;
      final prevBridgeSub = bridgeSub;
      bridgeSub = null;
      prevBridgeSub?.cancel();
      final instance = wireInstance;
      final Stream<dynamic> subStream;
      try {
        subStream = _bridgeClient.subscribeRaw({
          'target': {
            'service': 'rtdb',
            if (instance != null) 'instance': instance,
            'path': path,
            if (querySpec != null) 'query': querySpec,
          },
          'actAs': lens.toMap(),
        });
      } catch (e, st) {
        scheduleMicrotask(() {
          if (generation != listenGeneration || controller.isClosed) return;
          controller.addError(e, st);
          closeFromBridge();
        });
        return;
      }

      var sawRecoverableDenial = false;
      late final StreamSubscription<dynamic> currentSub;
      currentSub = subStream.listen(
        (event) {
          if (generation != listenGeneration || !identical(bridgeSub, currentSub)) {
            return;
          }
          if (!controller.isClosed) {
            controller.add(event);
          }
        },
        onError: (Object err, StackTrace st) {
          if (generation != listenGeneration || !identical(bridgeSub, currentSub)) {
            return;
          }
          if (_isRecoverableRtdbDenial(err)) {
            sawRecoverableDenial = true;
          }
          if (!controller.isClosed) {
            controller.addError(err, st);
          }
        },
        onDone: () {
          if (generation != listenGeneration || !identical(bridgeSub, currentSub)) {
            return;
          }
          bridgeSub = null;
          if (!_bridgeClient.isDisposed && sawRecoverableDenial) {
            return;
          }
          closeFromBridge();
        },
      );
      bridgeSub = currentSub;
    }

    controller = StreamController<dynamic>.broadcast(
      sync: true,
      onListen: () {
        final generation = ++listenGeneration;
        if (_bridgeClient.isDisposed) {
          scheduleMicrotask(() {
            if (generation != listenGeneration || controller.isClosed) return;
            controller.addError(const PyricBridgeException(
              code: 'unavailable',
              message: 'PyricBridgeClient has been disposed.',
            ));
            controller.close();
          });
          return;
        }
        final initialLens = effectiveLens;
        onLensChange?.call(initialLens);
        startListening(initialLens, generation);
        bridgeStateSub = _bridgeClient.connectionStates.listen(
          (state) {
            if (generation != listenGeneration) return;
            if (state == BridgeConnectionState.closed && bridgeSub == null) {
              closeFromBridge();
            }
          },
          onError: (Object _, StackTrace __) {},
        );
        authLensSub = authLensChanges.listen(
          (newLens) {
            if (generation != listenGeneration) return;
            if (newLens == activeLens) return;
            onLensChange?.call(newLens);
            startListening(newLens, generation);
          },
          onError: (Object _, StackTrace __) {},
        );
      },
      onCancel: () {
        listenGeneration++;
        final prevBridgeSub = bridgeSub;
        bridgeSub = null;
        final prevAuthLensSub = authLensSub;
        authLensSub = null;
        final prevStateSub = bridgeStateSub;
        bridgeStateSub = null;
        activeLens = null;
        if (prevBridgeSub != null) unawaited(prevBridgeSub.cancel());
        if (prevAuthLensSub != null) unawaited(prevAuthLensSub.cancel());
        if (prevStateSub != null) unawaited(prevStateSub.cancel());
      },
    );

    return controller.stream;
  }
}

/// Type alias conforming to `firebase_database` naming.
typedef FirebaseDatabase = PyricDatabase;
