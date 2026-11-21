import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_storage.dart';

import '../helpers/fake_bridge.dart';

const FirebaseOptions _edgeOpts = FirebaseOptions(
  apiKey: 'demo-storage-edge-1',
  appId: '1:101:android:edge1',
  messagingSenderId: '101',
  projectId: 'demo-edge-primary',
  storageBucket: 'demo-edge-primary.appspot.com',
);

class _SingleAppEdgePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = FirebaseAppPlatform(appName, options ?? _edgeOpts);
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps.putIfAbsent(name, () => FirebaseAppPlatform(name, _edgeOpts));
  }
}

class _BinaryEdgeResponder {
  final FakeBridge bridge;
  final Map<String, Uint8List> objects = <String, Uint8List>{};
  final Map<String, Map<String, dynamic>> metadataByKey =
      <String, Map<String, dynamic>>{};
  final Map<String, Map<int, Uint8List>> stagedParts =
      <String, Map<int, Uint8List>>{};
  final Map<String, Map<String, dynamic>> pendingUploads =
      <String, Map<String, dynamic>>{};
  final List<Map<String, dynamic>> recordedOps = <Map<String, dynamic>>[];

  bool forcePayloadTooLargeWithoutRange = false;
  int _uploadSeq = 0;
  int _genSeq = 0;

  _BinaryEdgeResponder(this.bridge) {
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

  String _bucketOf(Map<String, dynamic> op) =>
      (op['bucket'] as String?) ??
      (op['defaultBucket'] as String?) ??
      'pyric-default';

  void _replyOk(String id, Object? value) {
    bridge.current.deliver(<String, dynamic>{
      'type': 'worker-res',
      'id': id,
      'ok': true,
      'value': value,
    });
  }

  void _replyErr(String id, String code, String message) {
    bridge.current.deliver(<String, dynamic>{
      'type': 'worker-res',
      'id': id,
      'ok': false,
      'error': <String, String>{'code': code, 'message': message},
    });
  }

  Map<String, dynamic> _meta(String bucket, String path, int size) {
    _genSeq += 1;
    return <String, dynamic>{
      'bucket': bucket,
      'fullPath': path,
      'name': path.contains('/') ? path.split('/').last : path,
      'size': size,
      'generation': '$_genSeq',
      'metageneration': '1',
      'contentType': 'application/octet-stream',
      'timeCreated': '2026-11-21T08:00:00.000Z',
      'updated': '2026-11-21T08:00:01.000Z',
    };
  }

  void _dispatch(String id, Map<String, dynamic> op) {
    final method = op['method'] as String;
    switch (method) {
      case 'storage.putBytes':
        final bucket = _bucketOf(op);
        final path = op['path'] as String;
        final bytes =
            Uint8List.fromList(base64Decode(op['dataB64'] as String? ?? ''));
        final m = _meta(bucket, path, bytes.length);
        objects['$bucket|$path'] = bytes;
        metadataByKey['$bucket|$path'] = m;
        _replyOk(id, m);
      case 'storage.beginUpload':
        final uploadId = 'edge-up-${++_uploadSeq}';
        pendingUploads[uploadId] = <String, dynamic>{
          'bucket': _bucketOf(op),
          'path': op['path'] as String,
        };
        stagedParts[uploadId] = <int, Uint8List>{};
        _replyOk(id, <String, dynamic>{'uploadId': uploadId});
      case 'storage.putPart':
        final uploadId = op['uploadId'] as String;
        final partIndex = (op['partIndex'] as num).toInt();
        final bytes =
            Uint8List.fromList(base64Decode(op['dataB64'] as String? ?? ''));
        stagedParts[uploadId]![partIndex] = bytes;
        _replyOk(id, <String, dynamic>{'bytesReceived': bytes.length});
      case 'storage.finishUpload':
        final uploadId = op['uploadId'] as String;
        final pending = pendingUploads.remove(uploadId)!;
        final parts = stagedParts.remove(uploadId)!;
        final builder = BytesBuilder(copy: false);
        for (final idx in (parts.keys.toList()..sort())) {
          builder.add(parts[idx]!);
        }
        final assembled = builder.takeBytes();
        final bucket = pending['bucket'] as String;
        final path = pending['path'] as String;
        final m = _meta(bucket, path, assembled.length);
        objects['$bucket|$path'] = assembled;
        metadataByKey['$bucket|$path'] = m;
        _replyOk(id, m);
      case 'storage.getMetadata':
        final key = '${_bucketOf(op)}|${op['path'] as String}';
        final m = metadataByKey[key];
        if (m == null) {
          _replyErr(id, 'storage/object-not-found', 'Missing $key');
          return;
        }
        _replyOk(id, m);
      case 'storage.getBytes':
        final key = '${_bucketOf(op)}|${op['path'] as String}';
        final full = objects[key];
        if (full == null) {
          _replyErr(id, 'storage/object-not-found', 'Missing $key');
          return;
        }
        final hasRange = op.containsKey('offset') || op.containsKey('length');
        if (!hasRange &&
            (forcePayloadTooLargeWithoutRange ||
                full.length > 8 * 1024 * 1024)) {
          _replyErr(id, 'payload-too-large', 'Exceeds single-frame cap.');
          return;
        }
        final start = (op['offset'] as num?)?.toInt() ?? 0;
        final len = (op['length'] as num?)?.toInt() ?? (full.length - start);
        final end = start + len <= full.length ? start + len : full.length;
        final slice = start < end
            ? Uint8List.sublistView(full, start, end)
            : Uint8List(0);
        _replyOk(id, <String, dynamic>{
          'size': slice.length,
          'dataB64': base64Encode(slice),
        });
      default:
        _replyErr(id, 'storage/unknown', 'Unhandled $method');
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
  late _BinaryEdgeResponder responder;
  late PyricBridgeClient bridgeClient;
  late FirebaseApp primaryApp;
  late Directory scratchRoot;

  setUp(() async {
    FirebasePlatform.instance = _SingleAppEdgePlatform();
    primaryApp = await Firebase.initializeApp(options: _edgeOpts);
    fakeBridge = FakeBridge();
    responder = _BinaryEdgeResponder(fakeBridge);
    bridgeClient = PyricBridgeClient(
      uri: Uri.parse('ws://127.0.0.1:4555/__pyric/sandbox'),
      channelFactory: fakeBridge.connect,
    );
    final base = Directory('.dart_tool/pyric_storage_edge_scratch');
    if (!await base.exists()) {
      await base.create(recursive: true);
    }
    scratchRoot = await base.createTemp('edge_');
  });

  tearDown(() async {
    await PyricFirebaseStoragePlatform.clearInstancesForTest();
    await bridgeClient.disconnect();
    if (await scratchRoot.exists()) {
      await scratchRoot.delete(recursive: true);
    }
  });

  group('PR 3 binary and boundary edge cases', () {
    test('handles 0-byte empty uploads across all APIs and writeToFile 0-byte truncation', () async {
      final storage = PyricFirebaseStoragePlatform(
        appInstance: primaryApp,
        bridgeClient: bridgeClient,
      );

      final directMeta = await storage.uploadBytes('zero/direct.bin', Uint8List(0));
      expect(directMeta.size, equals(0));
      expect(await storage.ref('zero/direct.bin').getData(0), equals(Uint8List(0)));

      final putDataSnap =
          await storage.ref('zero/put_data.bin').putData(Uint8List(0)).onComplete;
      expect(putDataSnap.state, equals(TaskState.success));
      expect(putDataSnap.bytesTransferred, equals(0));
      expect(putDataSnap.totalBytes, equals(0));

      expect(
        (await storage.ref('zero/raw.txt').putString('', PutStringFormat.raw).onComplete)
            .totalBytes,
        equals(0),
      );
      expect(
        (await storage.ref('zero/b64.bin').putString('', PutStringFormat.base64).onComplete)
            .totalBytes,
        equals(0),
      );
      expect(
        (await storage
                .ref('zero/b64url.bin')
                .putString('', PutStringFormat.base64Url)
                .onComplete)
            .totalBytes,
        equals(0),
      );
      expect(
        (await storage
                .ref('zero/data_url.txt')
                .putString('data:,', PutStringFormat.dataUrl)
                .onComplete)
            .totalBytes,
        equals(0),
      );

      final emptyFile = File('${scratchRoot.path}/empty_src.bin');
      await emptyFile.writeAsBytes(const <int>[], flush: true);
      expect(
        (await storage.ref('zero/from_file.bin').putFile(emptyFile).onComplete)
            .totalBytes,
        equals(0),
      );
      expect(
        (await storage
                .ref('zero/from_stream.bin')
                .putBlob(const Stream<List<int>>.empty())
                .onComplete)
            .totalBytes,
        equals(0),
      );

      final destFile = File('${scratchRoot.path}/prepopulated.bin');
      await destFile.writeAsBytes(const <int>[1, 2, 3, 4, 5], flush: true);
      final opsBeforeDownload = responder.recordedOps.length;
      final dlSnap =
          await storage.ref('zero/put_data.bin').writeToFile(destFile).onComplete;
      expect(dlSnap.state, equals(TaskState.success));
      expect(dlSnap.bytesTransferred, equals(0));
      expect(await destFile.readAsBytes(), isEmpty);
      final newMethods = responder.recordedOps
          .sublist(opsBeforeDownload)
          .map((op) => op['method'] as String)
          .toList();
      expect(newMethods, equals(<String>['storage.getMetadata']));

      await storage.dispose();
    });

    test('streams multi-chunk TaskPlatform payloads (> 256 KB) with monotonic progress', () async {
      final storage = PyricFirebaseStoragePlatform(
        appInstance: primaryApp,
        bridgeClient: bridgeClient,
      );
      final payload = Uint8List.fromList(
        List<int>.generate(640 * 1024 + 19, (int i) => (i * 31 + 7) & 0xff),
      );

      final task = storage.ref('chunks/large_task.bin').putData(payload);
      final progressEvents = <int>[];
      final sub = task.snapshotEvents.listen((TaskSnapshotPlatform snap) {
        if (snap.state == TaskState.running) {
          progressEvents.add(snap.bytesTransferred);
        }
      });
      final done = await task.onComplete;
      await sub.cancel();

      expect(done.bytesTransferred, equals(payload.length));
      expect(
        progressEvents,
        containsAllInOrder(<int>[262144, 524288, payload.length]),
      );

      final outFile = File('${scratchRoot.path}/downloaded_large.bin');
      final dlDone =
          await storage.ref('chunks/large_task.bin').writeToFile(outFile).onComplete;
      expect(dlDone.bytesTransferred, equals(payload.length));
      expect(await outFile.readAsBytes(), equals(payload));

      await storage.dispose();
    });

    test('transfers multi-part objects (> 4 MiB) via uploadBytes and chunked getData fallback', () async {
      final storage = PyricFirebaseStoragePlatform(
        appInstance: primaryApp,
        bridgeClient: bridgeClient,
      );
      final bigPayload = Uint8List.fromList(
        List<int>.generate(4 * 1024 * 1024 + 131072, (int i) => (i * 13 + 3) & 0xff),
      );

      final meta = await storage.uploadBytes('multipart/over_4mib.bin', bigPayload);
      expect(meta.size, equals(bigPayload.length));
      final partOps = responder.recordedOps
          .where((op) => op['method'] == 'storage.putPart')
          .toList();
      expect(partOps.length, equals(2));

      responder.forcePayloadTooLargeWithoutRange = true;
      final fetched = await storage
          .ref('multipart/over_4mib.bin')
          .getData(5 * 1024 * 1024);
      expect(fetched, equals(bigPayload));

      await storage.dispose();
    });

    test('enforces getData(maxSize) exact boundaries across single-frame and chunked reads', () async {
      final storage = PyricFirebaseStoragePlatform(
        appInstance: primaryApp,
        bridgeClient: bridgeClient,
      );
      final exactBytes = Uint8List.fromList(List<int>.generate(128, (i) => i));
      await storage.uploadBytes('bounds/item.bin', exactBytes);

      await _expectCode(
        () => storage.ref('bounds/item.bin').getData(-1),
        'invalid-argument',
      );
      await _expectCode(
        () => storage.ref('bounds/item.bin').getData(0),
        'download-size-exceeded',
      );
      await _expectCode(
        () => storage.ref('bounds/item.bin').getData(127),
        'download-size-exceeded',
      );
      expect(await storage.ref('bounds/item.bin').getData(128), equals(exactBytes));

      responder.forcePayloadTooLargeWithoutRange = true;
      await _expectCode(
        () => storage.ref('bounds/item.bin').getData(127),
        'download-size-exceeded',
      );
      expect(await storage.ref('bounds/item.bin').getData(128), equals(exactBytes));

      await storage.dispose();
    });
  });
}
