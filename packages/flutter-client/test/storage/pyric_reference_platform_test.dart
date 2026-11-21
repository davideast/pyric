import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_storage.dart';

import '../helpers/fake_bridge.dart';

const FirebaseOptions _testOptions = FirebaseOptions(
  apiKey: 'demo-storage-api-key',
  appId: '1:333333333:android:demostorageref',
  messagingSenderId: '333333333',
  projectId: 'demo-flutter-storage-ref',
  storageBucket: 'demo-ref-bucket.appspot.com',
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
    final app = FirebaseAppPlatform(appName, options ?? _testOptions);
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps.putIfAbsent(
      name,
      () => FirebaseAppPlatform(name, _testOptions),
    );
  }
}

void main() {
  late FakeBridge fakeBridge;
  late PyricBridgeClient bridgeClient;
  late FirebaseApp app;
  late PyricFirebaseStoragePlatform storage;

  setUp(() async {
    FirebasePlatform.instance = _MockFirebasePlatform();
    app = await Firebase.initializeApp(options: _testOptions);

    fakeBridge = FakeBridge();
    bridgeClient = PyricBridgeClient(
      uri: Uri.parse('ws://127.0.0.1:4400/__pyric/sandbox'),
      channelFactory: fakeBridge.connect,
    );
    storage = PyricFirebaseStoragePlatform(
      appInstance: app,
      bucket: 'demo-ref-bucket.appspot.com',
      bridgeClient: bridgeClient,
    );
  });

  tearDown(() async {
    await storage.dispose();
    await PyricFirebaseStoragePlatform.clearInstancesForTest();
    await bridgeClient.disconnect();
  });

  group('PyricReferencePlatform root guards and read operations', () {
    test('rejects object-only operations on root reference without dispatching bridge frames', () async {
      final root = storage.ref('/');
      for (final action in <Future<Object?> Function()>[
        () => root.getData(1024),
        () => root.getDownloadURL(),
        () => root.getMetadata(),
        () => root.updateMetadata(SettableMetadata(contentType: 'text/plain')),
        () => root.delete(),
        () => storage.uploadBytes('/', Uint8List.fromList(<int>[1, 2, 3])),
      ]) {
        await expectLater(
          action(),
          throwsA(
            isA<FirebaseException>()
                .having((e) => e.plugin, 'plugin', 'firebase_storage')
                .having((e) => e.code, 'code', 'invalid-root-operation'),
          ),
        );
      }
      expect(fakeBridge.ofType('worker-op'), isEmpty);
    });

    test('downloads bytes via storage.getBytes and enforces maxSize bounds', () async {
      final expectedBytes = Uint8List.fromList(utf8.encode('hello pyric storage'));
      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') return;
        final op = frame['op'] as Map<String, dynamic>;
        if (op['method'] == 'storage.getBytes') {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{
                'dataB64': base64Encode(expectedBytes),
                'contentType': 'text/plain',
                'size': expectedBytes.length,
                'generation': '1',
              },
            });
          });
        }
      };

      final ref = storage.ref('notes/greeting.txt');
      await expectLater(
        ref.getData(-1),
        throwsA(isA<FirebaseException>().having((e) => e.code, 'code', 'invalid-argument')),
      );

      final data = await ref.getData(1024);
      expect(data, equals(expectedBytes));

      await expectLater(
        ref.getData(5),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.plugin, 'plugin', 'firebase_storage')
              .having((e) => e.code, 'code', 'download-size-exceeded'),
        ),
      );
    });

    test('falls back to range-read storage.getBytes chunks when single-frame read returns payload-too-large', () async {
      final partA = Uint8List.fromList(<int>[10, 20, 30, 40]);
      final partB = Uint8List.fromList(<int>[50, 60, 70]);
      final fullPayload = Uint8List.fromList(<int>[...partA, ...partB]);
      var rangeCallCount = 0;

      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') return;
        final op = frame['op'] as Map<String, dynamic>;
        final method = op['method'];
        if (method == 'storage.getBytes' && !op.containsKey('offset')) {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': false,
              'error': <String, dynamic>{
                'code': 'payload-too-large',
                'message': 'Exceeds single frame cap.',
              },
            });
          });
        } else if (method == 'storage.getMetadata') {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{
                'bucket': 'demo-ref-bucket.appspot.com',
                'fullPath': 'large/archive.bin',
                'name': 'archive.bin',
                'size': fullPayload.length,
                'generation': '9',
                'metageneration': '1',
              },
            });
          });
        } else if (method == 'storage.getBytes' && op.containsKey('offset')) {
          rangeCallCount += 1;
          final offset = (op['offset'] as num).toInt();
          final length = (op['length'] as num).toInt();
          expect(op['expectedGeneration'], equals('9'));
          final slice = fullPayload.sublist(offset, offset + length);
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{
                'dataB64': base64Encode(slice),
                'size': slice.length,
                'generation': '9',
              },
            });
          });
        }
      };

      final downloaded = await storage.ref('large/archive.bin').getData(1024);
      expect(downloaded, equals(fullPayload));
      expect(rangeCallCount, equals(1));
    });

    test('resolves relative byte-route paths in getDownloadURL against bridge HTTP origin', () async {
      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') return;
        final op = frame['op'] as Map<String, dynamic>;
        if (op['method'] == 'storage.getDownloadURL') {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{
                'path': '/__pyric/storage/v0/b/demo-ref-bucket.appspot.com/o/docs%2Fspec.pdf?alt=media&token=tok-99',
              },
            });
          });
        }
      };

      final url = await storage.ref('docs/spec.pdf').getDownloadURL();
      expect(
        url,
        equals(
          'http://127.0.0.1:4400/__pyric/storage/v0/b/demo-ref-bucket.appspot.com/o/docs%2Fspec.pdf?alt=media&token=tok-99',
        ),
      );
    });
  });

  group('PyricReferencePlatform metadata, list pagination, and delete', () {
    test('enforces caller write rules via beginUpload/abortUpload when storage.setMetadata requires admin plane', () async {
      final recordedOps = <Map<String, dynamic>>[];
      var denyCallerWrite = false;

      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') return;
        final op = Map<String, dynamic>.from(frame['op'] as Map);
        recordedOps.add(op);
        final method = op['method'];
        final isAdmin = op['actAs'] is Map && (op['actAs'] as Map)['mode'] == 'admin';

        if (method == 'storage.setMetadata' && !isAdmin) {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': false,
              'error': <String, dynamic>{
                'code': 'storage/unauthorized',
                'message':
                    'storage.setMetadata is the admin plane (firebase-admin File.setMetadata) and runs only on the admin lens.',
              },
            });
          });
          return;
        }

        if (method == 'storage.getMetadata' && isAdmin) {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{
                'bucket': 'demo-ref-bucket.appspot.com',
                'fullPath': 'users/u1/doc.txt',
                'name': 'doc.txt',
                'size': 42,
                'generation': '1',
                'metageneration': '1',
                'contentType': 'text/plain',
                'customMetadata': <String, String>{'oldKey': 'oldVal', 'keepKey': 'v1'},
              },
            });
          });
          return;
        }

        if (method == 'storage.beginUpload') {
          if (denyCallerWrite) {
            scheduleMicrotask(() {
              fakeBridge.current.deliver(<String, dynamic>{
                'type': 'worker-res',
                'id': frame['id'],
                'ok': false,
                'error': <String, dynamic>{
                  'code': 'storage/unauthorized',
                  'message': 'Write denied by Storage Rules.',
                },
              });
            });
            return;
          }
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{'uploadId': 'stage-1'},
            });
          });
          return;
        }

        if (method == 'storage.abortUpload') {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': null,
            });
          });
          return;
        }

        if (method == 'storage.setMetadata' && isAdmin) {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{
                'bucket': 'demo-ref-bucket.appspot.com',
                'fullPath': 'users/u1/doc.txt',
                'name': 'doc.txt',
                'size': 42,
                'generation': '1',
                'metageneration': '2',
                'contentType': 'application/json',
                'customMetadata': <String, String>{'keepKey': 'v2'},
              },
            });
          });
        }
      };

      final ref = storage.ref('users/u1/doc.txt');
      final updated = await ref.updateMetadata(
        SettableMetadata(
          contentType: 'application/json',
          customMetadata: <String, String>{'keepKey': 'v2'},
        ),
      );
      expect(updated.contentType, equals('application/json'));
      expect(updated.metageneration, equals('2'));
      expect(updated.metadataGeneration, equals('2'));
      expect(updated.generation, equals('1'));
      expect(updated.customMetadata, equals(<String, String>{'keepKey': 'v2'}));

      expect(
        recordedOps.map((op) => op['method']).toList(),
        equals(<String>[
          'storage.setMetadata',
          'storage.getMetadata',
          'storage.beginUpload',
          'storage.abortUpload',
          'storage.setMetadata',
        ]),
      );
      final adminPatch = (recordedOps.last['patch'] as Map)['customMetadata'] as Map;
      expect(adminPatch, equals(<String, Object?>{'oldKey': null, 'keepKey': 'v2'}));

      // When caller's session is denied by Storage Rules, beginUpload fails with unauthorized and admin setMetadata never runs.
      recordedOps.clear();
      denyCallerWrite = true;
      await expectLater(
        ref.updateMetadata(SettableMetadata(contentType: 'text/csv')),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.plugin, 'plugin', 'firebase_storage')
              .having((e) => e.code, 'code', 'unauthorized'),
        ),
      );
      expect(
        recordedOps.map((op) => op['method']).toList(),
        equals(<String>['storage.setMetadata', 'storage.getMetadata', 'storage.beginUpload']),
      );
    });

    test('paginates list(ListOptions) across prefixes and items and supports listAll and delete', () async {
      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') return;
        final op = frame['op'] as Map<String, dynamic>;
        if (op['method'] == 'storage.listAll') {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{
                'prefixes': <Map<String, String>>[
                  <String, String>{'fullPath': 'docs/2025', 'name': '2025'},
                  <String, String>{'fullPath': 'docs/2026', 'name': '2026'},
                ],
                'items': <Map<String, String>>[
                  <String, String>{'fullPath': 'docs/a.txt', 'name': 'a.txt'},
                  <String, String>{'fullPath': 'docs/b.txt', 'name': 'b.txt'},
                  <String, String>{'fullPath': 'docs/c.txt', 'name': 'c.txt'},
                ],
              },
            });
          });
        } else if (op['method'] == 'storage.deleteObject') {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': false,
              'error': <String, dynamic>{
                'code': 'storage/object-not-found',
                'message': 'Missing object.',
              },
            });
          });
        }
      };

      final folderRef = storage.ref('docs');
      final all = await folderRef.listAll();
      ListResultPlatform.verify(all);
      expect(all.nextPageToken, isNull);
      expect(all.prefixes.map((r) => r.fullPath).toList(), equals(<String>['docs/2025', 'docs/2026']));
      expect(
        all.items.map((r) => r.fullPath).toList(),
        equals(<String>['docs/a.txt', 'docs/b.txt', 'docs/c.txt']),
      );

      final page1 = await folderRef.list(const ListOptions(maxResults: 2));
      expect(page1.prefixes.map((r) => r.name).toList(), equals(<String>['2025', '2026']));
      expect(page1.items, isEmpty);
      expect(page1.nextPageToken, isNotNull);

      final page2 = await folderRef.list(
        ListOptions(maxResults: 2, pageToken: page1.nextPageToken),
      );
      expect(page2.prefixes, isEmpty);
      expect(page2.items.map((r) => r.name).toList(), equals(<String>['a.txt', 'b.txt']));
      expect(page2.nextPageToken, isNotNull);

      final page3 = await folderRef.list(
        ListOptions(maxResults: 2, pageToken: page2.nextPageToken),
      );
      expect(page3.prefixes, isEmpty);
      expect(page3.items.map((r) => r.name).toList(), equals(<String>['c.txt']));
      expect(page3.nextPageToken, isNull);

      await expectLater(
        folderRef.list(const ListOptions(maxResults: 0)),
        throwsA(isA<FirebaseException>().having((e) => e.code, 'code', 'invalid-argument')),
      );
      await expectLater(
        folderRef.list(const ListOptions(maxResults: 1001)),
        throwsA(isA<FirebaseException>().having((e) => e.code, 'code', 'invalid-argument')),
      );

      await expectLater(
        storage.ref('docs/missing.txt').delete(),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.plugin, 'plugin', 'firebase_storage')
              .having((e) => e.code, 'code', 'object-not-found'),
        ),
      );
    });

    test('uploads multi-part payloads over FakeBridge and aborts staged upload on part failure', () async {
      final recordedMethods = <String>[];
      var failPutPart = false;

      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') return;
        final op = frame['op'] as Map<String, dynamic>;
        final method = op['method'] as String;
        recordedMethods.add(method);

        if (method == 'storage.beginUpload') {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{'uploadId': 'up-multi-1'},
            });
          });
        } else if (method == 'storage.putPart') {
          if (failPutPart) {
            scheduleMicrotask(() {
              fakeBridge.current.deliver(<String, dynamic>{
                'type': 'worker-res',
                'id': frame['id'],
                'ok': false,
                'error': <String, dynamic>{
                  'code': 'storage/quota-exceeded',
                  'message': 'Part rejected.',
                },
              });
            });
            return;
          }
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{'bytesTransferred': maxStoragePartBytes},
            });
          });
        } else if (method == 'storage.finishUpload') {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{
                'bucket': 'demo-ref-bucket.appspot.com',
                'fullPath': 'videos/clip.bin',
                'name': 'clip.bin',
                'size': maxStoragePartBytes + 16,
                'generation': '1',
                'metageneration': '1',
                'contentType': 'application/octet-stream',
              },
            });
          });
        } else if (method == 'storage.abortUpload') {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': null,
            });
          });
        }
      };

      final bigBytes = Uint8List(maxStoragePartBytes + 16);
      final meta = await storage.uploadBytes(
        'videos/clip.bin',
        bigBytes,
        metadata: SettableMetadata(contentType: 'application/octet-stream'),
      );
      expect(meta.size, equals(maxStoragePartBytes + 16));
      expect(
        recordedMethods,
        equals(<String>[
          'storage.beginUpload',
          'storage.putPart',
          'storage.putPart',
          'storage.finishUpload',
        ]),
      );

      recordedMethods.clear();
      failPutPart = true;
      await expectLater(
        storage.uploadBytes('videos/clip-fail.bin', bigBytes),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.plugin, 'plugin', 'firebase_storage')
              .having((e) => e.code, 'code', 'quota-exceeded'),
        ),
      );
      expect(
        recordedMethods,
        equals(<String>['storage.beginUpload', 'storage.putPart', 'storage.abortUpload']),
      );
    });
  });
}
