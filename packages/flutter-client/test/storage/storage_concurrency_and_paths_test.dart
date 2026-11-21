import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_flutter_client.dart';
import 'package:pyric_firestore/pyric_storage.dart';

import '../helpers/fake_bridge.dart';

const FirebaseOptions _primaryOpts = FirebaseOptions(
  apiKey: 'demo-storage-edge-1',
  appId: '1:101:android:edge1',
  messagingSenderId: '101',
  projectId: 'demo-edge-primary',
  storageBucket: 'demo-edge-primary.appspot.com',
);

const FirebaseOptions _secondaryOpts = FirebaseOptions(
  apiKey: 'demo-storage-edge-2',
  appId: '1:202:ios:edge2',
  messagingSenderId: '202',
  projectId: 'demo-edge-secondary',
  storageBucket: 'gs://demo-edge-secondary.appspot.com',
);

class _MultiAppEdgePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = FirebaseAppPlatform(appName, options ?? _primaryOpts);
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    final existing = _apps[name];
    if (existing != null) {
      return existing;
    }
    throw FirebaseException(
      plugin: 'core',
      code: 'no-app',
      message: 'No Firebase App "$name" has been created.',
    );
  }
}

class _MultiBucketResponder {
  final FakeBridge bridge;
  final Map<String, Uint8List> objects = <String, Uint8List>{};
  final Map<String, Map<int, Uint8List>> stagedParts =
      <String, Map<int, Uint8List>>{};
  final Map<String, Map<String, dynamic>> pendingUploads =
      <String, Map<String, dynamic>>{};
  final List<Map<String, dynamic>> recordedOps = <Map<String, dynamic>>[];
  int _uploadSeq = 0;

  _MultiBucketResponder(this.bridge) {
    bridge.onFrame = (Map<String, dynamic> frame) {
      if (frame['type'] != 'worker-op') {
        return;
      }
      final id = frame['id'] as String;
      final op = Map<String, dynamic>.from(frame['op'] as Map);
      recordedOps.add(op);
      scheduleMicrotask(() => _dispatch(id, op));
    };
  }

  String _resolveBucket(Map<String, dynamic> op) {
    final explicit = op['bucket'] as String?;
    if (explicit != null && explicit.isNotEmpty) {
      return explicit;
    }
    return (op['defaultBucket'] as String?) ?? 'pyric-default';
  }

  void _replyOk(String id, Object? value) {
    bridge.current.deliver(<String, dynamic>{
      'type': 'worker-res',
      'id': id,
      'ok': true,
      'value': value,
    });
  }

  void _dispatch(String id, Map<String, dynamic> op) {
    switch (op['method'] as String) {
      case 'storage.beginUpload':
        final uploadId = 'mc-up-${++_uploadSeq}';
        pendingUploads[uploadId] = <String, dynamic>{
          'bucket': _resolveBucket(op),
          'path': op['path'] as String,
        };
        stagedParts[uploadId] = <int, Uint8List>{};
        _replyOk(id, <String, dynamic>{'uploadId': uploadId});
      case 'storage.putPart':
        final uploadId = op['uploadId'] as String;
        final partIndex = (op['partIndex'] as num).toInt();
        stagedParts[uploadId]![partIndex] =
            Uint8List.fromList(base64Decode(op['dataB64'] as String? ?? ''));
        _replyOk(id, <String, dynamic>{'bytesReceived': 0});
      case 'storage.finishUpload':
        final uploadId = op['uploadId'] as String;
        final pending = pendingUploads.remove(uploadId)!;
        final parts = stagedParts.remove(uploadId)!;
        final builder = BytesBuilder(copy: false);
        for (final idx in (parts.keys.toList()..sort())) {
          builder.add(parts[idx]!);
        }
        final bytes = builder.takeBytes();
        final bucket = pending['bucket'] as String;
        final path = pending['path'] as String;
        objects['$bucket|$path'] = bytes;
        _replyOk(id, <String, dynamic>{
          'bucket': bucket,
          'fullPath': path,
          'name': path.contains('/') ? path.split('/').last : path,
          'size': bytes.length,
          'generation': '1',
          'metageneration': '1',
          'contentType': 'application/octet-stream',
          'timeCreated': '2026-11-21T08:00:00.000Z',
          'updated': '2026-11-21T08:00:01.000Z',
        });
      case 'storage.getBytes':
        final key = '${_resolveBucket(op)}|${op['path'] as String}';
        final bytes = objects[key]!;
        _replyOk(id, <String, dynamic>{
          'size': bytes.length,
          'dataB64': base64Encode(bytes),
        });
      case 'storage.getDownloadURL':
        final bucket = _resolveBucket(op);
        final path = op['path'] as String;
        final encBucket = Uri.encodeComponent(bucket);
        final encPath = Uri.encodeComponent(path);
        _replyOk(id, <String, dynamic>{
          'path': '/__pyric/storage/v0/b/$encBucket/o/$encPath?alt=media&token=t1',
        });
      case 'storage.abortUpload':
        final uploadId = op['uploadId'] as String;
        pendingUploads.remove(uploadId);
        stagedParts.remove(uploadId);
        _replyOk(id, null);
    }
  }
}

Future<FirebaseException> _expectCode(
  FutureOr<Object?> Function() action,
  String expectedCode,
) async {
  try {
    await action();
    fail('Expected FirebaseException($expectedCode)');
  } on FirebaseException catch (error) {
    expect(error.plugin, equals('firebase_storage'));
    expect(error.code, equals(expectedCode));
    return error;
  }
}

void main() {
  late FakeBridge fakeBridge;
  late _MultiBucketResponder responder;
  late PyricBridgeClient bridgeClient;
  late FirebaseApp primaryApp;
  late FirebaseApp secondaryApp;

  setUp(() async {
    FirebasePlatform.instance = _MultiAppEdgePlatform();
    primaryApp = await Firebase.initializeApp(options: _primaryOpts);
    secondaryApp = await Firebase.initializeApp(
      name: 'secondary',
      options: _secondaryOpts,
    );
    fakeBridge = FakeBridge();
    responder = _MultiBucketResponder(fakeBridge);
    bridgeClient = PyricBridgeClient(
      uri: Uri.parse('ws://127.0.0.1:4556/__pyric/sandbox'),
      channelFactory: fakeBridge.connect,
    );
  });

  tearDown(() async {
    await PyricFirebaseStoragePlatform.clearInstancesForTest();
    await bridgeClient.disconnect();
  });

  group('PR 3 path/URL normalization and multi-app concurrency', () {
    test('normalizes Unicode, spaces, literal %, and repeated slashes across ref, URLs, and wire ops', () async {
      PyricFirebaseStoragePlatform.registerWith(bridgeClient: bridgeClient);
      final storage = FirebaseStoragePlatform.instanceFor(
        app: primaryApp,
        bucket: '',
      ) as PyricFirebaseStoragePlatform;

      final messyRef = storage
          .ref('///users//u_1///')
          .child('//caf\u00e9 \u65e5\u672c\u8a9e//100%raw file.txt///');
      expect(
        messyRef.fullPath,
        equals('users/u_1/caf\u00e9 \u65e5\u672c\u8a9e/100%raw file.txt'),
      );
      expect(messyRef.name, equals('100%raw file.txt'));
      expect(
        messyRef.parent?.fullPath,
        equals('users/u_1/caf\u00e9 \u65e5\u672c\u8a9e'),
      );

      final bytes = Uint8List.fromList(utf8.encode('unicode-payload-\u00e9'));
      await messyRef.putData(bytes).onComplete;
      final url = await messyRef.getDownloadURL();
      final roundTripped = storage.refFromURL(url);
      expect(roundTripped.fullPath, equals(messyRef.fullPath));
      expect(roundTripped.bucket, equals('demo-edge-primary.appspot.com'));
      expect(await roundTripped.getData(256), equals(bytes));

      final viaRefGs = storage.ref('gs://custom-b//folder//caf\u00e9.txt/');
      expect(viaRefGs.bucket, equals('custom-b'));
      expect(viaRefGs.fullPath, equals('folder/caf\u00e9.txt'));

      final viaRefV1 = storage.ref(
        'https://firebasestorage.googleapis.com/v1/b/custom-b/o/folder%2Fcaf%C3%A9.txt?alt=media',
      );
      expect(viaRefV1.bucket, equals('custom-b'));
      expect(viaRefV1.fullPath, equals('folder/caf\u00e9.txt'));
    });

    test('rejects data: URIs, malformed %ZZ URLs, and URLs passed to Reference.child()', () async {
      final storage = PyricFirebaseStoragePlatform(
        appInstance: primaryApp,
        bridgeClient: bridgeClient,
      );

      await _expectCode(
        () => storage.ref('data:text/plain;base64,SGVsbG8='),
        'invalid-url',
      );
      await _expectCode(
        () => storage.refFromURL('data:text/plain,hello'),
        'invalid-url',
      );
      await _expectCode(
        () => storage.refFromURL(
          'https://firebasestorage.googleapis.com/v0/b/my-b/o/bad%ZZescape',
        ),
        'invalid-url',
      );
      await _expectCode(
        () => storage.refFromURL(
          'https://firebasestorage.googleapis.com/v0/b/my-b/o?name=bad%2',
        ),
        'invalid-url',
      );
      await _expectCode(
        () => storage.ref('folder').child('gs://my-b/other.txt'),
        'invalid-argument',
      );
      await _expectCode(
        () => storage.ref('folder').child(
              'https://firebasestorage.googleapis.com/v0/b/my-b/o/x',
            ),
        'invalid-argument',
      );
      await _expectCode(
        () => storage.ref('folder').child('data:text/plain,inline'),
        'invalid-url',
      );

      await storage.dispose();
    });

    test('executes concurrent uploads and downloads across multiple FirebaseApp and custom bucket delegates', () async {
      PyricFirebaseStoragePlatform.registerWith(bridgeClient: bridgeClient);
      final primaryDefault = FirebaseStoragePlatform.instanceFor(
        app: primaryApp,
        bucket: '',
      ) as PyricFirebaseStoragePlatform;
      final primaryCustom = FirebaseStoragePlatform.instanceFor(
        app: primaryApp,
        bucket: 'gs://shared-custom-media',
      ) as PyricFirebaseStoragePlatform;
      final secondaryDefault = FirebaseStoragePlatform.instanceFor(
        app: secondaryApp,
        bucket: '',
      ) as PyricFirebaseStoragePlatform;

      expect(secondaryDefault.usesNamedBucket, isFalse);
      expect(
        secondaryDefault.bucketWireParams(),
        equals(<String, dynamic>{
          'defaultBucket': 'demo-edge-primary.appspot.com',
          'bucket': 'demo-edge-secondary.appspot.com',
        }),
      );

      final bytesA = Uint8List.fromList(utf8.encode('primary-default-same-key'));
      final bytesB = Uint8List.fromList(utf8.encode('primary-custom-same-key'));
      final bytesC = Uint8List.fromList(utf8.encode('secondary-default-same-key'));

      await Future.wait(<Future<Object?>>[
        primaryDefault.ref('concurrent/shared.txt').putData(bytesA).onComplete,
        primaryCustom.ref('concurrent/shared.txt').putData(bytesB).onComplete,
        secondaryDefault.ref('concurrent/shared.txt').putData(bytesC).onComplete,
      ]);

      final downloaded = await Future.wait(<Future<Uint8List?>>[
        primaryDefault.ref('concurrent/shared.txt').getData(256),
        primaryCustom.ref('concurrent/shared.txt').getData(256),
        secondaryDefault.ref('concurrent/shared.txt').getData(256),
      ]);
      expect(downloaded[0], equals(bytesA));
      expect(downloaded[1], equals(bytesB));
      expect(downloaded[2], equals(bytesC));
    });

    test('isolates cross-bucket refFromURL delegates across standalone AuthLens instances', () async {
      final aliceStorage = PyricFirebaseStoragePlatform(
        appInstance: primaryApp,
        bridgeClient: bridgeClient,
        authLens: AuthLens.asUser(uid: 'alice'),
      );
      final bobStorage = PyricFirebaseStoragePlatform(
        appInstance: primaryApp,
        bridgeClient: bridgeClient,
        authLens: AuthLens.asUser(uid: 'bob'),
      );

      final aliceCrossRef = aliceStorage.refFromURL('gs://vault-bucket/item.bin');
      final bobCrossRef = bobStorage.refFromURL('gs://vault-bucket/item.bin');
      expect(identical(aliceCrossRef.storage, bobCrossRef.storage), isFalse);

      await Future.wait(<Future<Object?>>[
        aliceCrossRef
            .putData(Uint8List.fromList(utf8.encode('from-alice')))
            .onComplete,
        bobStorage
            .refFromURL('gs://vault-bucket/bob.bin')
            .putData(Uint8List.fromList(utf8.encode('from-bob')))
            .onComplete,
      ]);

      final uids = responder.recordedOps
          .where((op) => op['method'] == 'storage.beginUpload')
          .map((op) => (op['actAs'] as Map?)?['uid'] as String?)
          .toSet();
      expect(uids, equals(<String?>{'alice', 'bob'}));

      await aliceStorage.dispose();
      expect(
        (aliceCrossRef.storage as PyricFirebaseStoragePlatform).isDisposed,
        isTrue,
      );
      expect(
        (bobCrossRef.storage as PyricFirebaseStoragePlatform).isDisposed,
        isFalse,
      );
      await bobStorage.dispose();
    });
  });
}
