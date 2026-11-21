import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart'
    show Firebase, FirebaseApp, FirebaseException;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_storage.dart';

class _LiveStorageFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final resolvedOptions = options ??
        const FirebaseOptions(
          apiKey: 'demo-flutter-live-api-key',
          appId: '1:424242424242:android:flutterstoragelive',
          messagingSenderId: '424242424242',
          projectId: 'demo-flutter-live',
          storageBucket: 'demo-flutter-live.appspot.com',
        );
    final app = FirebaseAppPlatform(appName, resolvedOptions);
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps.putIfAbsent(
      name,
      () => FirebaseAppPlatform(
        name,
        const FirebaseOptions(
          apiKey: 'demo-flutter-live-api-key',
          appId: '1:424242424242:android:flutterstoragelive',
          messagingSenderId: '424242424242',
          projectId: 'demo-flutter-live',
          storageBucket: 'demo-flutter-live.appspot.com',
        ),
      ),
    );
  }
}

Uri? _resolveLiveBridgeUri() {
  final primary = Platform.environment['PYRIC_LIVE_BRIDGE_URL']?.trim() ?? '';
  if (primary.isNotEmpty) {
    return Uri.parse(primary);
  }
  final fallback = Platform.environment['PYRIC_BRIDGE_URL']?.trim() ?? '';
  if (fallback.isNotEmpty) {
    return Uri.parse(fallback);
  }
  return null;
}

String _resolveLiveProjectId() {
  final raw = Platform.environment['PYRIC_LIVE_PROJECT_ID']?.trim() ?? '';
  return raw.isNotEmpty ? raw : 'demo-flutter-live';
}

bool _isDedicatedStorageHost() {
  return Platform.environment['PYRIC_LIVE_STORAGE_HOST']?.trim() == '1';
}

Future<FirebaseException> _expectStorageCode(
  Future<Object?> Function() action,
  String expectedCode,
) async {
  try {
    await action();
    fail('Expected FirebaseException(plugin: firebase_storage, code: $expectedCode)');
  } on FirebaseException catch (error) {
    expect(error.plugin, equals('firebase_storage'));
    expect(
      error.code,
      equals(expectedCode),
      reason: 'Expected code $expectedCode, got ${error.code}: ${error.message}',
    );
    return error;
  }
}

Future<_HttpFetchResult> _fetchHttpUrl(Uri uri) async {
  final httpClient = HttpClient();
  try {
    final request = await httpClient.getUrl(uri);
    final response = await request.close();
    final builder = BytesBuilder(copy: false);
    await for (final chunk in response) {
      builder.add(chunk);
    }
    return _HttpFetchResult(
      statusCode: response.statusCode,
      contentType: response.headers.value(HttpHeaders.contentTypeHeader),
      body: builder.takeBytes(),
    );
  } finally {
    httpClient.close(force: false);
  }
}

class _HttpFetchResult {
  final int statusCode;
  final String? contentType;
  final Uint8List body;

  const _HttpFetchResult({
    required this.statusCode,
    required this.contentType,
    required this.body,
  });
}

void main() {
  HttpOverrides? previousHttpOverrides;
  Uri? bridgeUri;
  late String projectId;
  late String defaultBucket;
  FirebaseApp? liveApp;
  PyricBridgeClient? liveClient;
  PyricFirebaseAuthPlatform? liveAuth;
  PyricFirebaseStoragePlatform? liveStorage;
  PyricFirebaseStoragePlatform? liveCustomStorage;
  String ownerUid = '';

  setUpAll(() async {
    previousHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
    bridgeUri = _resolveLiveBridgeUri();
    projectId = _resolveLiveProjectId();
    defaultBucket = '$projectId.appspot.com';
    FirebasePlatform.instance = _LiveStorageFirebasePlatform();

    if (bridgeUri == null) {
      return;
    }

    liveApp = await Firebase.initializeApp(
      name: 'flutter-storage-live-${DateTime.now().microsecondsSinceEpoch}',
      options: FirebaseOptions(
        apiKey: 'demo-flutter-live-api-key',
        appId: '1:424242424242:android:flutterstoragelive',
        messagingSenderId: '424242424242',
        projectId: projectId,
        storageBucket: defaultBucket,
      ),
    );
    liveClient = PyricBridgeClient(
      uri: bridgeUri,
      headers: <String, dynamic>{'Host': '${bridgeUri!.host}:${bridgeUri!.port}'},
    );
    await liveClient!.connect();

    if (_isDedicatedStorageHost()) {
      liveAuth = PyricFirebaseAuthPlatform(
        appInstance: liveApp,
        bridgeClient: liveClient,
      );
      PyricFirebaseAuthPlatform.registerWith(bridgeClient: liveClient);
      PyricFirebaseStoragePlatform.registerWith(
        bridgeClient: liveClient,
        credentialsProvider: liveAuth,
      );
      liveStorage = FirebaseStoragePlatform.instanceFor(
        app: liveApp!,
        bucket: '',
      ) as PyricFirebaseStoragePlatform;
      liveCustomStorage = FirebaseStoragePlatform.instanceFor(
        app: liveApp!,
        bucket: 'gs://flutter-custom-media',
      ) as PyricFirebaseStoragePlatform;
    } else {
      PyricFirebaseStoragePlatform.registerWith(bridgeClient: liveClient);
      liveStorage = FirebaseStoragePlatform.instanceFor(
        app: liveApp!,
        bucket: '',
      ) as PyricFirebaseStoragePlatform;
    }
  });

  tearDownAll(() async {
    await liveAuth?.dispose();
    await PyricFirebaseStoragePlatform.clearInstancesForTest();
    await liveClient?.disconnect();
    HttpOverrides.global = previousHttpOverrides;
  });

  group('Pyric Flutter Cloud Storage live-host conformance', () {
    test('storage-live#1: enforces Storage Security Rules against unauthenticated callers', () async {
      if (bridgeUri == null) {
        final app = await Firebase.initializeApp(
          name: 'offline-rules-${DateTime.now().microsecondsSinceEpoch}',
        );
        final root = PyricFirebaseStoragePlatform.registerWith();
        final delegate = FirebaseStoragePlatform.instanceFor(
          app: app,
          bucket: 'gs://demo-flutter-live.appspot.com',
        );
        expect(identical(root.setInitialValues(), root), isTrue);
        expect(delegate.bucket, equals('demo-flutter-live.appspot.com'));
        await PyricFirebaseStoragePlatform.clearInstancesForTest();
        return;
      }

      final storage = liveStorage!;
      final lockedRef = storage.ref('users/unauthed/secret.txt');
      await _expectStorageCode(() => lockedRef.getMetadata(), 'unauthorized');
      await _expectStorageCode(() => lockedRef.getDownloadURL(), 'unauthorized');
      await _expectStorageCode(() => storage.ref('users/unauthed').listAll(), 'unauthorized');
      await _expectStorageCode(() => lockedRef.delete(), 'unauthorized');

      if (_isDedicatedStorageHost()) {
        await _expectStorageCode(
          () => storage.uploadBytes(
            'users/unauthed/secret.txt',
            Uint8List.fromList(utf8.encode('blocked')),
          ),
          'unauthorized',
        );
        await _expectStorageCode(() => lockedRef.getData(1024), 'unauthorized');
      }
    });

    test('storage-live#2: authenticates owner and round-trips object bytes with maxSize enforcement', () async {
      if (bridgeUri == null) {
        final storage = PyricFirebaseStoragePlatform(bucket: 'demo.appspot.com');
        storage.setMaxDownloadRetryTime(90000);
        expect(storage.maxDownloadRetryTime, equals(90000));
        await storage.dispose();
        return;
      }

      if (!_isDedicatedStorageHost()) {
        final adminStorage = PyricFirebaseStoragePlatform(
          appInstance: liveApp,
          bucket: defaultBucket,
          bridgeClient: liveClient,
          authLens: AuthLens.admin,
        );
        final meta = await adminStorage.uploadBytes(
          'admin-zero/probe.bin',
          Uint8List(0),
          metadata: SettableMetadata(contentType: 'application/octet-stream'),
        );
        expect(meta.size, equals(0));
        expect(await adminStorage.ref('admin-zero/probe.bin').getData(64), equals(Uint8List(0)));
        await adminStorage.ref('admin-zero/probe.bin').delete();
        await adminStorage.dispose();
        return;
      }

      final credential = await liveAuth!.createUserWithEmailAndPassword(
        'storage-owner@example.test',
        'correct-horse-battery-staple',
      );
      ownerUid = credential.user!.uid;
      expect(ownerUid.isNotEmpty, isTrue);

      final storage = liveStorage!;
      final textBytes = Uint8List.fromList(
        utf8.encode('Pyric Flutter Storage live conformance payload'),
      );
      final binBytes = Uint8List.fromList(
        List<int>.generate(512, (index) => (index * 37 + 13) & 0xff),
      );

      final uploadedMeta = await storage.uploadBytes(
        'users/$ownerUid/docs/readme.txt',
        textBytes,
        metadata: SettableMetadata(
          contentType: 'text/plain',
          cacheControl: 'private, max-age=60',
          customMetadata: <String, String>{'stage': 'initial', 'owner': ownerUid},
        ),
      );
      expect(uploadedMeta.bucket, equals(defaultBucket));
      expect(uploadedMeta.size, equals(textBytes.length));
      expect(uploadedMeta.timeCreated, isNotNull);

      await storage.uploadBytes(
        'users/$ownerUid/docs/sub/binary.bin',
        binBytes,
        metadata: SettableMetadata(contentType: 'application/octet-stream'),
      );

      await _expectStorageCode(
        () => storage.uploadBytes('users/other-uid/docs/intrude.txt', textBytes),
        'unauthorized',
      );

      expect(await storage.ref('users/$ownerUid/docs/readme.txt').getData(1024), equals(textBytes));
      expect(await storage.ref('users/$ownerUid/docs/sub/binary.bin').getData(1024), equals(binBytes));
      await _expectStorageCode(
        () => storage.ref('users/$ownerUid/docs/sub/binary.bin').getData(64),
        'download-size-exceeded',
      );
    });

    test('storage-live#3: reads and patches metadata while preserving generation and enforcing write rules', () async {
      if (bridgeUri == null) {
        final patch = encodeWireMetadataPatch(
          SettableMetadata(contentType: 'text/markdown', customMetadata: const <String, String>{'k': 'v'}),
          existingCustomMetadata: const <String, String>{'old': '1'},
        );
        expect((patch['customMetadata'] as Map)['old'], isNull);
        return;
      }

      if (!_isDedicatedStorageHost()) {
        final adminStorage = PyricFirebaseStoragePlatform(
          appInstance: liveApp,
          bucket: defaultBucket,
          bridgeClient: liveClient,
          authLens: AuthLens.admin,
        );
        await adminStorage.uploadBytes(
          'admin-zero/meta.bin',
          Uint8List(0),
          metadata: SettableMetadata(
            contentType: 'text/plain',
            customMetadata: const <String, String>{'a': '1'},
          ),
        );
        final updated = await adminStorage.ref('admin-zero/meta.bin').updateMetadata(
              SettableMetadata(
                contentType: 'application/json',
                customMetadata: const <String, String>{'b': '2'},
              ),
            );
        expect(updated.contentType, equals('application/json'));
        expect(updated.customMetadata, equals(<String, String>{'b': '2'}));
        await adminStorage.ref('admin-zero/meta.bin').delete();
        await adminStorage.dispose();
        return;
      }

      final storage = liveStorage!;
      final readmeRef = storage.ref('users/$ownerUid/docs/readme.txt');
      final before = await readmeRef.getMetadata();
      final updated = await readmeRef.updateMetadata(
        SettableMetadata(
          contentType: 'text/markdown; charset=utf-8',
          contentDisposition: 'inline; filename="readme.md"',
          customMetadata: const <String, String>{'stage': 'updated'},
        ),
      );
      expect(updated.generation, equals(before.generation));
      expect(
        int.parse(updated.metageneration ?? '0'),
        greaterThan(int.parse(before.metageneration ?? '1')),
      );
      expect(updated.contentType, equals('text/markdown; charset=utf-8'));
      expect(updated.customMetadata, equals(<String, String>{'stage': 'updated'}));

      await _expectStorageCode(
        () => storage.ref('users/other-uid/docs/readme.txt').updateMetadata(
              SettableMetadata(contentType: 'text/plain'),
            ),
        'unauthorized',
      );
    });

    test('storage-live#4: mints persistent HTTP download URLs and round-trips refFromURL', () async {
      if (bridgeUri == null) {
        final storage = PyricFirebaseStoragePlatform(bucket: 'demo-flutter-live.appspot.com');
        final fromHttp = storage.refFromURL(
          'http://127.0.0.1:5174/__pyric/storage/v0/b/demo-flutter-live.appspot.com/o/users%2Fu1%2Freadme.txt?alt=media&token=t1',
        );
        expect(fromHttp.fullPath, equals('users/u1/readme.txt'));
        await storage.dispose();
        return;
      }

      if (!_isDedicatedStorageHost()) {
        final adminStorage = PyricFirebaseStoragePlatform(
          appInstance: liveApp,
          bucket: defaultBucket,
          bridgeClient: liveClient,
          authLens: AuthLens.admin,
        );
        await adminStorage.uploadBytes('admin-zero/url.bin', Uint8List(0));
        final url = await adminStorage.ref('admin-zero/url.bin').getDownloadURL();
        expect(url, contains('/__pyric/storage/v0/b/'));
        expect(adminStorage.refFromURL(url).fullPath, equals('admin-zero/url.bin'));
        await adminStorage.ref('admin-zero/url.bin').delete();
        await adminStorage.dispose();
        return;
      }

      final storage = liveStorage!;
      final readmeRef = storage.ref('users/$ownerUid/docs/readme.txt');
      final downloadUrl = await readmeRef.getDownloadURL();
      expect(
        downloadUrl,
        startsWith('http://${bridgeUri!.host}:${bridgeUri!.port}/__pyric/storage/v0/b/'),
      );
      expect(downloadUrl, contains('token='));

      final parsedRef = storage.refFromURL(downloadUrl);
      expect(parsedRef.bucket, equals(defaultBucket));
      expect(parsedRef.fullPath, equals('users/$ownerUid/docs/readme.txt'));

      final fetched = await _fetchHttpUrl(Uri.parse(downloadUrl));
      expect(fetched.statusCode, equals(200));
      expect(fetched.contentType, contains('text/markdown'));
      expect(
        utf8.decode(fetched.body),
        equals('Pyric Flutter Storage live conformance payload'),
      );
    });

    test('storage-live#5: enumerates items and prefixes via listAll and paginated list(ListOptions)', () async {
      if (bridgeUri == null) {
        final token = encodeStorageListPageToken(3);
        expect(decodeStorageListPageToken(token), equals(3));
        return;
      }

      if (!_isDedicatedStorageHost()) {
        final adminStorage = PyricFirebaseStoragePlatform(
          appInstance: liveApp,
          bucket: defaultBucket,
          bridgeClient: liveClient,
          authLens: AuthLens.admin,
        );
        await adminStorage.uploadBytes('admin-list/a.bin', Uint8List(0));
        await adminStorage.uploadBytes('admin-list/sub/b.bin', Uint8List(0));
        final listed = await adminStorage.ref('admin-list').listAll();
        expect(listed.prefixes.map((r) => r.name).toList(), equals(<String>['sub']));
        expect(listed.items.map((r) => r.name).toList(), equals(<String>['a.bin']));
        await adminStorage.ref('admin-list/a.bin').delete();
        await adminStorage.ref('admin-list/sub/b.bin').delete();
        await adminStorage.dispose();
        return;
      }

      final docsRef = liveStorage!.ref('users/$ownerUid/docs');
      final all = await docsRef.listAll();
      expect(
        all.prefixes.map((r) => r.fullPath).toList(),
        equals(<String>['users/$ownerUid/docs/sub']),
      );
      expect(
        all.items.map((r) => r.fullPath).toList(),
        equals(<String>['users/$ownerUid/docs/readme.txt']),
      );

      final page1 = await docsRef.list(const ListOptions(maxResults: 1));
      expect(page1.prefixes.length, equals(1));
      expect(page1.items, isEmpty);
      expect(page1.nextPageToken, isNotNull);

      final page2 = await docsRef.list(
        ListOptions(maxResults: 1, pageToken: page1.nextPageToken),
      );
      expect(page2.prefixes, isEmpty);
      expect(page2.items.map((r) => r.name).toList(), equals(<String>['readme.txt']));
      expect(page2.nextPageToken, isNull);
    });

    test('storage-live#6: isolates custom buckets, supports useStorageEmulator, and deletes objects cleanly', () async {
      if (bridgeUri == null) {
        final storage = PyricFirebaseStoragePlatform(bucket: 'gs://flutter-custom-media');
        expect(storage.resolvedBucket, equals('flutter-custom-media'));
        expect(storage.ref('public/banner.txt').toString(), equals('gs://flutter-custom-media/public/banner.txt'));
        await storage.dispose();
        return;
      }

      if (!_isDedicatedStorageHost()) {
        final emulatorStorage = PyricFirebaseStoragePlatform(appInstance: liveApp);
        await emulatorStorage.useStorageEmulator(bridgeUri!.host, bridgeUri!.port);
        await _expectStorageCode(
          () => emulatorStorage.ref('locked/probe.txt').getMetadata(),
          'unauthorized',
        );
        await emulatorStorage.dispose();
        return;
      }

      final storage = liveStorage!;
      final customStorage = liveCustomStorage!;
      final customPayload = Uint8List.fromList(utf8.encode('custom-bucket-asset'));

      await customStorage.uploadBytes(
        'public/$ownerUid/banner.txt',
        customPayload,
        metadata: SettableMetadata(contentType: 'text/plain'),
      );
      final customRef = storage.refFromURL('gs://flutter-custom-media/public/$ownerUid/banner.txt');
      expect(customRef.bucket, equals('flutter-custom-media'));
      expect(await customRef.getData(1024), equals(customPayload));

      await _expectStorageCode(
        () => storage.ref('public/$ownerUid/banner.txt').getMetadata(),
        'object-not-found',
      );

      final anonCustom = PyricFirebaseStoragePlatform(
        appInstance: liveApp,
        bucket: 'gs://flutter-custom-media',
        bridgeClient: liveClient,
        authLens: AuthLens.anon,
      );
      expect(await anonCustom.ref('public/$ownerUid/banner.txt').getData(1024), equals(customPayload));
      await _expectStorageCode(
        () => anonCustom.uploadBytes('public/$ownerUid/hack.txt', customPayload),
        'unauthorized',
      );
      await anonCustom.dispose();

      final emulatorStorage = PyricFirebaseStoragePlatform(
        appInstance: liveApp,
        bucket: 'gs://flutter-custom-media',
      );
      await emulatorStorage.useStorageEmulator(bridgeUri!.host, bridgeUri!.port);
      expect(
        await emulatorStorage.ref('public/$ownerUid/banner.txt').getData(1024),
        equals(customPayload),
      );
      await emulatorStorage.dispose();

      final readmeRef = storage.ref('users/$ownerUid/docs/readme.txt');
      final binaryRef = storage.ref('users/$ownerUid/docs/sub/binary.bin');
      await readmeRef.delete();
      await binaryRef.delete();
      await customRef.delete();
      await _expectStorageCode(() => readmeRef.getMetadata(), 'object-not-found');
      await _expectStorageCode(() => readmeRef.getData(1024), 'object-not-found');
      await _expectStorageCode(() => readmeRef.delete(), 'object-not-found');
    });
  });
}
