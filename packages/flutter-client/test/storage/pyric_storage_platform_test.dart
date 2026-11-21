import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_flutter_client.dart';
import 'package:pyric_firestore/pyric_storage.dart';

import '../helpers/fake_bridge.dart';

const FirebaseOptions _primaryOptions = FirebaseOptions(
  apiKey: 'demo-storage-api-key',
  appId: '1:111111111:android:demostorage',
  messagingSenderId: '111111111',
  projectId: 'demo-flutter-storage',
  storageBucket: 'demo-flutter-storage.appspot.com',
);

const FirebaseOptions _secondaryOptions = FirebaseOptions(
  apiKey: 'demo-storage-api-key-2',
  appId: '1:222222222:ios:demostorage2',
  messagingSenderId: '222222222',
  projectId: 'demo-flutter-storage-2',
  storageBucket: 'gs://secondary-storage-bucket',
);

class _MockFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = FirebaseAppPlatform(appName, options ?? _primaryOptions);
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps.putIfAbsent(
      name,
      () => FirebaseAppPlatform(name, _primaryOptions),
    );
  }
}

class _StubCredentialsProvider implements PyricAuthCredentialsProvider {
  AuthLens lens;

  _StubCredentialsProvider(this.lens);

  @override
  AuthLens get currentAuthLens => lens;

  @override
  Stream<AuthLens> get authLensChanges => const Stream<AuthLens>.empty();
}

void main() {
  late FakeBridge fakeBridge;
  late PyricBridgeClient bridgeClient;
  late FirebaseApp primaryApp;
  late FirebaseApp secondaryApp;

  setUp(() async {
    FirebasePlatform.instance = _MockFirebasePlatform();
    primaryApp = await Firebase.initializeApp(options: _primaryOptions);
    secondaryApp = await Firebase.initializeApp(
      name: 'secondary',
      options: _secondaryOptions,
    );

    fakeBridge = FakeBridge();
    bridgeClient = PyricBridgeClient(
      uri: Uri.parse('ws://127.0.0.1:4400/__pyric/sandbox'),
      channelFactory: fakeBridge.connect,
    );
  });

  tearDown(() async {
    await PyricFirebaseStoragePlatform.clearInstancesForTest();
    await bridgeClient.disconnect();
  });

  group('PyricFirebaseStoragePlatform delegates, buckets, and retry timers', () {
    test('caches delegates per (FirebaseApp, normalized bucket) and resolves default vs named buckets', () {
      final root = PyricFirebaseStoragePlatform.registerWith(
        bridgeClient: bridgeClient,
      );
      expect(identical(FirebaseStoragePlatform.instance, root), isTrue);
      expect(identical(root.setInitialValues(), root), isTrue);

      final defaultDelegateA = FirebaseStoragePlatform.instanceFor(
        app: primaryApp,
        bucket: '',
      ) as PyricFirebaseStoragePlatform;
      final defaultDelegateB = FirebaseStoragePlatform.instanceFor(
        app: primaryApp,
        bucket: 'gs://demo-flutter-storage.appspot.com/',
      ) as PyricFirebaseStoragePlatform;
      expect(identical(defaultDelegateA, defaultDelegateB), isTrue);
      expect(defaultDelegateA.resolvedBucket, equals('demo-flutter-storage.appspot.com'));
      expect(defaultDelegateA.usesNamedBucket, isFalse);
      expect(
        defaultDelegateA.bucketWireParams(),
        equals(<String, dynamic>{'defaultBucket': 'demo-flutter-storage.appspot.com'}),
      );

      final customBucketDelegate = FirebaseStoragePlatform.instanceFor(
        app: primaryApp,
        bucket: 'gs://custom-assets-bucket',
      ) as PyricFirebaseStoragePlatform;
      expect(identical(customBucketDelegate, defaultDelegateA), isFalse);
      expect(customBucketDelegate.resolvedBucket, equals('custom-assets-bucket'));
      expect(customBucketDelegate.usesNamedBucket, isTrue);
      expect(
        customBucketDelegate.bucketWireParams(),
        equals(<String, dynamic>{
          'defaultBucket': 'demo-flutter-storage.appspot.com',
          'bucket': 'custom-assets-bucket',
        }),
      );

      final secondaryDelegate = FirebaseStoragePlatform.instanceFor(
        app: secondaryApp,
        bucket: '',
      ) as PyricFirebaseStoragePlatform;
      expect(secondaryDelegate.resolvedBucket, equals('secondary-storage-bucket'));
      expect(secondaryDelegate.usesNamedBucket, isFalse);
    });

    test('exposes standard FlutterFire retry timer defaults and validates updates', () {
      final storage = PyricFirebaseStoragePlatform(
        appInstance: primaryApp,
        bridgeClient: bridgeClient,
      );
      expect(storage.maxOperationRetryTime, equals(120000));
      expect(storage.maxUploadRetryTime, equals(600000));
      expect(storage.maxDownloadRetryTime, equals(600000));

      storage.setMaxOperationRetryTime(45000);
      storage.setMaxUploadRetryTime(180000);
      storage.setMaxDownloadRetryTime(90000);
      expect(storage.maxOperationRetryTime, equals(45000));
      expect(storage.maxUploadRetryTime, equals(180000));
      expect(storage.maxDownloadRetryTime, equals(90000));

      for (final setter in <void Function()>[
        () => storage.setMaxOperationRetryTime(-1),
        () => storage.setMaxUploadRetryTime(-5),
        () => storage.setMaxDownloadRetryTime(-10),
      ]) {
        expect(
          setter,
          throwsA(
            isA<FirebaseException>()
                .having((e) => e.plugin, 'plugin', 'firebase_storage')
                .having((e) => e.code, 'code', 'invalid-argument'),
          ),
        );
      }
    });

    test('validates useStorageEmulator arguments and preserves shared bridgeClient on delegate dispose', () async {
      final delegate = PyricFirebaseStoragePlatform(
        appInstance: primaryApp,
        bridgeClient: bridgeClient,
      );
      await bridgeClient.connect();
      expect(bridgeClient.isConnected, isTrue);

      await expectLater(
        delegate.useStorageEmulator('', 9199),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.plugin, 'plugin', 'firebase_storage')
              .having((e) => e.code, 'code', 'invalid-argument'),
        ),
      );
      await expectLater(
        delegate.useStorageEmulator('127.0.0.1', 0),
        throwsA(isA<FirebaseException>().having((e) => e.code, 'code', 'invalid-argument')),
      );
      await expectLater(
        delegate.useStorageEmulator('127.0.0.1', 70000),
        throwsA(isA<FirebaseException>().having((e) => e.code, 'code', 'invalid-argument')),
      );

      // Disposing a delegate borrowing a shared bridgeClient does NOT disconnect the shared client.
      await delegate.dispose();
      expect(delegate.isDisposed, isTrue);
      expect(bridgeClient.isConnected, isTrue);
      expect(
        () => delegate.ref('docs/a.txt'),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.plugin, 'plugin', 'firebase_storage')
              .having((e) => e.code, 'code', 'canceled'),
        ),
      );
    });
  });

  group('PyricFirebaseStoragePlatform ref, refFromURL, and AuthLens propagation', () {
    test('navigates ReferencePlatform hierarchy (root, parent, child, name, fullPath, toString)', () {
      final storage = PyricFirebaseStoragePlatform(
        appInstance: primaryApp,
        bucket: 'demo-flutter-storage.appspot.com',
        bridgeClient: bridgeClient,
      );

      final rootRef = storage.ref();
      ReferencePlatform.verify(rootRef);
      expect(rootRef.fullPath, equals(''));
      expect(rootRef.name, equals(''));
      expect(rootRef.parent, isNull);
      expect(rootRef.bucket, equals('demo-flutter-storage.appspot.com'));
      expect(rootRef.toString(), equals('gs://demo-flutter-storage.appspot.com/'));

      final nested = rootRef.child('/users//u1/profile/avatar.png/');
      expect(nested.fullPath, equals('users/u1/profile/avatar.png'));
      expect(nested.name, equals('avatar.png'));
      expect(nested.root.fullPath, equals(''));
      expect(nested.parent?.fullPath, equals('users/u1/profile'));
      expect(nested.parent?.parent?.fullPath, equals('users/u1'));
      expect(nested.parent?.parent?.parent?.fullPath, equals('users'));
      expect(nested.parent?.parent?.parent?.parent?.fullPath, equals(''));
      expect(nested.parent?.parent?.parent?.parent?.parent, isNull);
      expect(
        nested.toString(),
        equals('gs://demo-flutter-storage.appspot.com/users/u1/profile/avatar.png'),
      );
    });

    test('resolves refFromURL across same-bucket and cross-bucket gs:// and HTTP URLs', () {
      PyricFirebaseStoragePlatform.registerWith(bridgeClient: bridgeClient);
      final storage = FirebaseStoragePlatform.instanceFor(
        app: primaryApp,
        bucket: '',
      ) as PyricFirebaseStoragePlatform;

      final sameBucketRef = storage.refFromURL(
        'gs://demo-flutter-storage.appspot.com/reports/q1.csv',
      );
      expect(sameBucketRef.bucket, equals('demo-flutter-storage.appspot.com'));
      expect(sameBucketRef.fullPath, equals('reports/q1.csv'));
      expect(identical(sameBucketRef.storage, storage), isTrue);

      final crossBucketRef = storage.refFromURL(
        'http://127.0.0.1:4400/__pyric/storage/v0/b/media-vault/o/clips%2Fintro%201.mp4?alt=media&token=tok-1',
      );
      expect(crossBucketRef.bucket, equals('media-vault'));
      expect(crossBucketRef.fullPath, equals('clips/intro 1.mp4'));
      expect(crossBucketRef.name, equals('intro 1.mp4'));
      expect(
        (crossBucketRef.storage as PyricFirebaseStoragePlatform).usesNamedBucket,
        isTrue,
      );
    });

    test('forwards credentialsProvider and explicit AuthLens overrides onto Storage worker-op frames', () async {
      final capturedFrames = <Map<String, dynamic>>[];
      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') return;
        capturedFrames.add(frame);
        scheduleMicrotask(() {
          fakeBridge.current.deliver(<String, dynamic>{
            'type': 'worker-res',
            'id': frame['id'],
            'ok': true,
            'value': null,
          });
        });
      };

      final provider = _StubCredentialsProvider(AuthLens.appSession);
      final storage = PyricFirebaseStoragePlatform(
        appInstance: primaryApp,
        bridgeClient: bridgeClient,
        credentialsProvider: provider,
      );
      final itemRef = storage.ref('items/doc.txt');

      // AppSessionLens omits actAs so the host uses the port's interactive Auth session.
      await itemRef.delete();
      final firstOp = capturedFrames[0]['op'] as Map<String, dynamic>;
      expect(firstOp.containsKey('actAs'), isFalse);

      // Provider-supplied AsUserLens attaches actAs: { mode: 'as', uid: 'user-7' }.
      provider.lens = AuthLens.asUser(uid: 'user-7');
      await itemRef.delete();
      final secondOp = capturedFrames[1]['op'] as Map<String, dynamic>;
      expect(secondOp['actAs'], equals(<String, dynamic>{'mode': 'as', 'uid': 'user-7'}));

      // Explicit storage.authLens overrides the provider lens.
      storage.authLens = AuthLens.anon;
      await itemRef.delete();
      final thirdOp = capturedFrames[2]['op'] as Map<String, dynamic>;
      expect(thirdOp['actAs'], equals(<String, dynamic>{'mode': 'anon'}));
    });
  });
}
