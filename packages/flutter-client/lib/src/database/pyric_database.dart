import 'dart:async';

import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';
// ignore: depend_on_referenced_packages
import 'package:firebase_core/firebase_core.dart';

import '../auth/auth_lens.dart';
import '../auth/pyric_auth_credentials_provider.dart';
import '../transport/bridge_client.dart';
import 'pyric_database_reference.dart';

/// Entry point for the Pyric Realtime Database client SDK.
class PyricDatabase {
  static PyricDatabase? _defaultInstance;
  static final Map<String, PyricDatabase> _urlInstances = {};

  final PyricBridgeClient _bridgeClient;
  PyricAuthCredentialsProvider? _credentialsProvider;
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

  /// Resolves the active [AuthLens] map for stamping on operations.
  Map<String, dynamic> get effectiveAuthLens {
    final provider = credentialsProvider;
    if (provider != null) {
      return provider.currentAuthLens.toMap();
    }
    return const {'mode': 'anon'};
  }

  /// Emits whenever the active [AuthLens] transitions.
  Stream<AuthLens> get authLensChanges {
    final provider = credentialsProvider;
    if (provider != null) {
      return provider.authLensChanges;
    }
    return const Stream.empty();
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
  Future<void> goOffline() async {
    await op('rtdb.goOffline', const {});
  }

  /// Resumes the Realtime Database connection to the Pyric worker.
  Future<void> goOnline() async {
    await op('rtdb.goOnline', const {});
  }

  /// Dispatches an RTDB worker operation stamped with the active [AuthLens].
  Future<dynamic> op(String method, Map<String, dynamic> params) {
    return _bridgeClient.op(
      method,
      params,
      actAs: effectiveAuthLens,
    );
  }

  /// Establishes an RTDB real-time subscription that automatically resubscribes upon [AuthLens] change.
  Stream<dynamic> subscribeRtdb(
    String path, {
    Map<String, dynamic>? querySpec,
  }) {
    late StreamController<dynamic> controller;
    StreamSubscription<dynamic>? bridgeSub;
    StreamSubscription<AuthLens>? authLensSub;

    void startListening(Map<String, dynamic> actAs) {
      bridgeSub?.cancel();
      final subStream = _bridgeClient.subscribeRaw({
        'target': {
          'service': 'rtdb',
          'path': path,
          if (querySpec != null) 'query': querySpec,
        },
        'actAs': actAs,
      });
      bridgeSub = subStream.listen(
        (event) {
          controller.add(event);
        },
        onError: (Object err, StackTrace st) {
          controller.addError(err, st);
        },
      );
    }

    controller = StreamController<dynamic>.broadcast(
      onListen: () {
        startListening(effectiveAuthLens);
        authLensSub = authLensChanges.listen((newLens) {
          startListening(newLens.toMap());
        });
      },
      onCancel: () async {
        await authLensSub?.cancel();
        authLensSub = null;
        await bridgeSub?.cancel();
        bridgeSub = null;
      },
    );

    return controller.stream;
  }
}

/// Type alias conforming to `firebase_database` naming.
typedef FirebaseDatabase = PyricDatabase;
