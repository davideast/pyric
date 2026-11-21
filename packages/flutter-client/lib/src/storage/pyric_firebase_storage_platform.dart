import 'dart:async';
import 'dart:typed_data';

import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_storage_platform_interface/firebase_storage_platform_interface.dart';

import '../auth/auth_lens.dart';
import '../auth/pyric_auth_credentials_provider.dart';
import '../transport/bridge_client.dart';
import 'pyric_reference_platform.dart';
import 'pyric_task_platform.dart';
import 'storage_byte_transfer.dart';
import 'storage_transfer_runner.dart';
import 'storage_wire_codec.dart';

const int _defaultMaxOperationRetryTimeMillis = 2 * 60 * 1000;
const int _defaultMaxUploadRetryTimeMillis = 10 * 60 * 1000;
const int _defaultMaxDownloadRetryTimeMillis = 10 * 60 * 1000;

/// Concrete [FirebaseStoragePlatform] executing Cloud Storage operations over the Pyric WebSocket bridge.
class PyricFirebaseStoragePlatform extends FirebaseStoragePlatform {
  static final Map<String, PyricFirebaseStoragePlatform> _delegatesByKey =
      <String, PyricFirebaseStoragePlatform>{};

  PyricBridgeClient _bridgeClient;
  bool _ownsBridgeClient;
  final PyricAuthCredentialsProvider? _credentialsProvider;
  /// Optional explicit [AuthLens] override on this Storage instance.
  AuthLens? authLens;
  final String? _sessionToken;
  /// Chunk byte size used by resumable upload and file download tasks.
  final int taskChunkSize;
  bool _isDisposed = false;

  int _maxOperationRetryTime = _defaultMaxOperationRetryTimeMillis;
  int _maxUploadRetryTime = _defaultMaxUploadRetryTimeMillis;
  int _maxDownloadRetryTime = _defaultMaxDownloadRetryTimeMillis;

  final Set<PyricTaskPlatform> _activeTasks = <PyricTaskPlatform>{};
  final Map<String, PyricFirebaseStoragePlatform> _scopedDelegatesByKey =
      <String, PyricFirebaseStoragePlatform>{};
  late StorageByteTransfer _byteTransfer = StorageByteTransfer(this);

  PyricFirebaseStoragePlatform({
    super.appInstance,
    String bucket = '',
    PyricBridgeClient? bridgeClient,
    PyricAuthCredentialsProvider? credentialsProvider,
    this.authLens,
    String? sessionToken,
    this.taskChunkSize = defaultStorageTaskChunkBytes,
  })  : _bridgeClient = bridgeClient ?? PyricBridgeClient(),
        _ownsBridgeClient = bridgeClient == null,
        _credentialsProvider = credentialsProvider,
        _sessionToken = sessionToken,
        super(bucket: normalizeStorageBucketSpec(bucket));

  /// Access the underlying Pyric WebSocket bridge client.
  PyricBridgeClient get bridgeClient => _bridgeClient;

  /// Byte-transfer collaborator shared by references on this instance.
  StorageByteTransfer get byteTransfer => _byteTransfer;

  /// Whether this instance has been disposed.
  bool get isDisposed => _isDisposed;

  /// Resolves the effective bucket name (`this.bucket`, falling back to `app.options.storageBucket`).
  String get resolvedBucket {
    if (bucket.isNotEmpty) {
      return bucket;
    }
    final configured = _defaultAppBucket;
    if (configured != null && configured.isNotEmpty) {
      return configured;
    }
    return '';
  }

  /// Whether this Storage instance targets a non-default named bucket.
  bool get usesNamedBucket {
    if (bucket.isEmpty) {
      return false;
    }
    final defaultBucket = _defaultAppBucket;
    if (defaultBucket != null && defaultBucket.isNotEmpty) {
      return bucket != defaultBucket;
    }
    return true;
  }

  /// HTTP origin derived from the active bridge WebSocket URI (`http(s)://<host>:<port>`).
  Uri get httpBaseOrigin {
    final wsUri = _bridgeClient.uri;
    final scheme = wsUri.scheme == 'wss' ? 'https' : 'http';
    return Uri(
      scheme: scheme,
      host: wsUri.host,
      port: wsUri.hasPort ? wsUri.port : null,
    );
  }

  @override
  int get maxOperationRetryTime => _maxOperationRetryTime;

  @override
  int get maxUploadRetryTime => _maxUploadRetryTime;

  @override
  int get maxDownloadRetryTime => _maxDownloadRetryTime;

  @override
  void setMaxOperationRetryTime(int time) {
    _checkNotDisposed();
    if (time < 0) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'invalid-argument',
        message: 'maxOperationRetryTime must be non-negative, got $time.',
      );
    }
    _maxOperationRetryTime = time;
  }

  @override
  void setMaxUploadRetryTime(int time) {
    _checkNotDisposed();
    if (time < 0) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'invalid-argument',
        message: 'maxUploadRetryTime must be non-negative, got $time.',
      );
    }
    _maxUploadRetryTime = time;
  }

  @override
  void setMaxDownloadRetryTime(int time) {
    _checkNotDisposed();
    if (time < 0) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'invalid-argument',
        message: 'maxDownloadRetryTime must be non-negative, got $time.',
      );
    }
    _maxDownloadRetryTime = time;
  }

  /// Registers [PyricFirebaseStoragePlatform] as [FirebaseStoragePlatform.instance].
  static PyricFirebaseStoragePlatform registerWith({
    PyricBridgeClient? bridgeClient,
    String bucket = '',
    PyricAuthCredentialsProvider? credentialsProvider,
    AuthLens? authLens,
    String? sessionToken,
    int taskChunkSize = defaultStorageTaskChunkBytes,
  }) {
    _delegatesByKey.clear();
    final root = PyricFirebaseStoragePlatform(
      bucket: bucket,
      bridgeClient: bridgeClient,
      credentialsProvider: credentialsProvider,
      authLens: authLens,
      sessionToken: sessionToken,
      taskChunkSize: taskChunkSize,
    );
    FirebaseStoragePlatform.instance = root;
    return root;
  }

  /// Clears cached per-app/per-bucket delegates between test runs.
  static Future<void> clearInstancesForTest() async {
    final delegates = _delegatesByKey.values.toList();
    _delegatesByKey.clear();
    for (final delegate in delegates) {
      await delegate.dispose();
    }
  }

  static String _delegateKey(String appName, String normalizedBucket) {
    return '$appName|$normalizedBucket';
  }

  @override
  FirebaseStoragePlatform delegateFor({
    required FirebaseApp app,
    required String bucket,
  }) {
    final normalizedBucket = normalizeStorageBucketSpec(bucket);
    final effectiveBucket = normalizedBucket.isNotEmpty
        ? normalizedBucket
        : _extractAppDefaultBucket(app);
    final key = _delegateKey(app.name, effectiveBucket);
    final targetRegistry = identical(this, FirebaseStoragePlatform.instance)
        ? _delegatesByKey
        : _scopedDelegatesByKey;
    return targetRegistry.putIfAbsent(key, () {
      return PyricFirebaseStoragePlatform(
        appInstance: app,
        bucket: effectiveBucket,
        bridgeClient: _bridgeClient,
        credentialsProvider: _credentialsProvider,
        authLens: authLens,
        sessionToken: _sessionToken,
        taskChunkSize: taskChunkSize,
      );
    });
  }

  /// Configures initial platform state and returns this instance, matching [PyricFirebaseAppCheckPlatform].
  PyricFirebaseStoragePlatform setInitialValues() {
    return this;
  }

  @override
  ReferencePlatform ref([String path = '/']) {
    _checkNotDisposed();
    if (isStorageUrlInput(path)) {
      return refFromURL(path);
    }
    return PyricReferencePlatform(this, path);
  }

  /// Creates a [ReferencePlatform] from a `gs://` or `http(s)://` Firebase/GCS/Pyric Storage URL.
  ReferencePlatform refFromURL(String url) {
    _checkNotDisposed();
    final parsed = parseStorageUrlLocation(url);
    final currentBucket = resolvedBucket;
    if (parsed.bucket.isNotEmpty && parsed.bucket != currentBucket) {
      final targetApp = _tryResolveApp();
      if (targetApp != null) {
        final targetStorage = delegateFor(
          app: targetApp,
          bucket: parsed.bucket,
        ) as PyricFirebaseStoragePlatform;
        return PyricReferencePlatform(targetStorage, parsed.path);
      }
      final key = _delegateKey('', parsed.bucket);
      final scoped = _scopedDelegatesByKey.putIfAbsent(key, () {
        return PyricFirebaseStoragePlatform(
          bucket: parsed.bucket,
          bridgeClient: _bridgeClient,
          credentialsProvider: _credentialsProvider,
          authLens: authLens,
          sessionToken: _sessionToken,
          taskChunkSize: taskChunkSize,
        );
      });
      return PyricReferencePlatform(scoped, parsed.path);
    }
    return PyricReferencePlatform(this, parsed.path);
  }

  /// Connects this instance to a specific Pyric bridge host and port (`ws://<host>:<port>/__pyric/sandbox`).
  @override
  Future<void> useStorageEmulator(String host, int port) async {
    _checkNotDisposed();
    if (host.trim().isEmpty || port <= 0 || port > 65535) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'invalid-argument',
        message: 'Invalid Storage bridge endpoint: $host:$port',
      );
    }
    final normalizedHost =
        host.contains(':') && !host.startsWith('[') ? '[$host]' : host;
    emulatorHost = host;
    emulatorPort = port;
    final endpoint = Uri.parse('ws://$normalizedHost:$port/__pyric/sandbox');
    final nextClient = PyricBridgeClient(
      uri: endpoint,
      headers: <String, dynamic>{'Host': '$normalizedHost:$port'},
    );
    final previousClient = _bridgeClient;
    final ownedPrevious = _ownsBridgeClient;
    _bridgeClient = nextClient;
    _ownsBridgeClient = true;
    _byteTransfer = StorageByteTransfer(this);
    if (ownedPrevious) {
      await previousClient.disconnect();
    }
    await _bridgeClient.connect();
  }

  /// Uploads raw [bytes] to [path] using this instance's configured bucket and auth lens.
  Future<FullMetadata> uploadBytes(
    String path,
    Uint8List bytes, {
    SettableMetadata? metadata,
  }) async {
    _checkNotDisposed();
    final wirePath = normalizeStorageWirePath(path);
    if (wirePath.isEmpty) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'invalid-root-operation',
        message: 'uploadBytes cannot operate on the root reference.',
      );
    }
    try {
      return await _byteTransfer.uploadBytes(
        wirePath: wirePath,
        bytes: bytes,
        bucketParams: bucketWireParams(),
        metadata: metadata,
        fallbackBucket: resolvedBucket,
      );
    } catch (error, stackTrace) {
      throw mapToStorageFirebaseException(error, stackTrace);
    }
  }

  /// Dispatches a Storage worker operation over the bridge, ensuring connection and active auth lens.
  Future<dynamic> dispatchStorageOp(
    String method,
    Map<String, dynamic> params, {
    Map<String, dynamic>? actAsOverride,
    Duration? timeoutOverride,
  }) async {
    _checkNotDisposed();
    await _ensureBridgeConnected();
    final effectiveTimeout = timeoutOverride ??
        Duration(milliseconds: _timeoutMillisForMethod(method));
    return _bridgeClient.op(
      method,
      params,
      actAs: actAsOverride ?? _resolveActAsMap(),
      timeout: effectiveTimeout,
    );
  }

  /// Builds `StorageBucketWire` fields (`bucket` and/or `defaultBucket`) for outbound Storage ops.
  Map<String, dynamic> bucketWireParams() {
    final wire = <String, dynamic>{};
    final defaultAppBucket = _defaultAppBucket;
    final primaryDefaultBucket = _tryResolvePrimaryDefaultBucket();
    final wireDefaultBucket =
        (primaryDefaultBucket != null && primaryDefaultBucket.isNotEmpty)
            ? primaryDefaultBucket
            : defaultAppBucket;
    if (wireDefaultBucket != null && wireDefaultBucket.isNotEmpty) {
      wire['defaultBucket'] = wireDefaultBucket;
    }
    final resolved = resolvedBucket;
    final differsFromHostDefault = resolved.isNotEmpty &&
        wireDefaultBucket != null &&
        wireDefaultBucket.isNotEmpty &&
        resolved != wireDefaultBucket;
    if ((usesNamedBucket && bucket.isNotEmpty) || differsFromHostDefault) {
      wire['bucket'] = resolved;
    }
    return wire;
  }

  /// Headers authorizing SDK reads on the HostedRuntime HTTP byte route.
  Map<String, String> byteRouteReadHeaders() {
    final headers = <String, String>{
      'x-pyric-byte-route': '1',
    };
    final token = _sessionToken;
    if (token != null && token.isNotEmpty) {
      headers['x-pyric-session-token'] = token;
    }
    return headers;
  }

  /// Registers an active [PyricTaskPlatform] so [dispose] can cancel in-flight transfers.
  void registerActiveTask(PyricTaskPlatform task) {
    if (!_isDisposed) {
      _activeTasks.add(task);
    }
  }

  /// Unregisters a settled [PyricTaskPlatform].
  void unregisterActiveTask(PyricTaskPlatform task) {
    _activeTasks.remove(task);
  }

  /// Disposes this Storage platform instance, cancels active tasks, and disconnects any owned bridge client.
  Future<void> dispose() async {
    if (_isDisposed) {
      return;
    }
    _isDisposed = true;
    final tasks = _activeTasks.toList(growable: false);
    _activeTasks.clear();
    for (final task in tasks) {
      await task.disposeTask();
    }
    final scopedDelegates = _scopedDelegatesByKey.values.toList(growable: false);
    _scopedDelegatesByKey.clear();
    for (final scopedDelegate in scopedDelegates) {
      if (!identical(scopedDelegate, this)) {
        await scopedDelegate.dispose();
      }
    }
    final targetApp = _tryResolveApp();
    if (targetApp != null) {
      final key = _delegateKey(targetApp.name, resolvedBucket);
      if (identical(_delegatesByKey[key], this)) {
        _delegatesByKey.remove(key);
      }
    }
    if (_ownsBridgeClient) {
      await _bridgeClient.disconnect();
    }
  }

  /// Whether this instance currently dispatches operations on the rules-bypass admin lens.
  bool get usesAdminLens {
    final actAs = _resolveActAsMap();
    return actAs != null && actAs['mode'] == 'admin';
  }

  void ensureUsable() {
    _checkNotDisposed();
  }

  int _timeoutMillisForMethod(String method) {
    if (method == 'storage.putBytes' ||
        method == 'storage.beginUpload' ||
        method == 'storage.putPart' ||
        method == 'storage.finishUpload' ||
        method == 'storage.abortUpload' ||
        method == 'storage.rollbackUpload') {
      return _maxUploadRetryTime > 0 ? _maxUploadRetryTime : 1;
    }
    if (method == 'storage.getBytes' || method == 'storage.getBlob') {
      return _maxDownloadRetryTime > 0 ? _maxDownloadRetryTime : 1;
    }
    return _maxOperationRetryTime > 0 ? _maxOperationRetryTime : 1;
  }

  Map<String, dynamic>? _resolveActAsMap() {
    final explicitLens = authLens;
    if (explicitLens != null) {
      if (explicitLens is AppSessionLens) {
        return null;
      }
      return explicitLens.toMap();
    }
    final provider = _resolveCredentialsProvider();
    final lens = provider?.currentAuthLens;
    if (lens == null || lens is AppSessionLens) {
      return null;
    }
    return lens.toMap();
  }

  PyricAuthCredentialsProvider? _resolveCredentialsProvider() {
    if (_credentialsProvider != null) {
      return _credentialsProvider;
    }
    try {
      final authInstance = FirebaseAuthPlatform.instance;
      if (authInstance is PyricAuthCredentialsProvider) {
        return authInstance as PyricAuthCredentialsProvider;
      }
    } catch (_) {
      // Auth platform not initialized or using non-Pyric implementation.
    }
    return null;
  }

  String? get _defaultAppBucket {
    final targetApp = _tryResolveApp();
    if (targetApp == null) {
      return null;
    }
    final extracted = _extractAppDefaultBucket(targetApp);
    return extracted.isEmpty ? null : extracted;
  }

  String? _tryResolvePrimaryDefaultBucket() {
    try {
      final primaryApp = Firebase.app();
      final extracted = _extractAppDefaultBucket(primaryApp);
      return extracted.isEmpty ? null : extracted;
    } catch (_) {
      return _defaultAppBucket;
    }
  }

  static String _extractAppDefaultBucket(FirebaseApp app) {
    final raw = app.options.storageBucket?.trim() ?? '';
    if (raw.isEmpty) {
      return '';
    }
    return normalizeStorageBucketSpec(raw);
  }

  FirebaseApp? _tryResolveApp() {
    if (appInstance != null) {
      return appInstance;
    }
    try {
      return Firebase.app();
    } catch (_) {
      return null;
    }
  }

  Future<void> _ensureBridgeConnected() async {
    if (!_bridgeClient.isConnected) {
      await _bridgeClient.connect();
    }
  }

  void _checkNotDisposed() {
    if (_isDisposed) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'canceled',
        message: 'PyricFirebaseStoragePlatform instance has already been disposed.',
      );
    }
  }
}
