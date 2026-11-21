import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_storage.dart';

import '../helpers/fake_bridge.dart';

class _FileAndBlobBridgeServer {
  final FakeBridge bridge;
  final Map<String, Uint8List> objects = <String, Uint8List>{};
  final Map<String, Map<String, dynamic>> metadata =
      <String, Map<String, dynamic>>{};
  final Map<String, Map<int, Uint8List>> parts =
      <String, Map<int, Uint8List>>{};
  final Map<String, Map<String, dynamic>> pending =
      <String, Map<String, dynamic>>{};
  int _counter = 0;

  _FileAndBlobBridgeServer(this.bridge) {
    bridge.onFrame = (Map<String, dynamic> frame) {
      if (frame['type'] != 'worker-op') {
        return;
      }
      final id = frame['id'] as String;
      final op = Map<String, dynamic>.from(frame['op'] as Map);
      scheduleMicrotask(() => _handle(id, op));
    };
  }

  void _handle(String id, Map<String, dynamic> op) {
    final method = op['method'] as String;
    final bucket = (op['bucket'] as String?) ??
        (op['defaultBucket'] as String?) ??
        'demo-bucket';
    switch (method) {
      case 'storage.beginUpload':
        final uploadId = 'fup-${++_counter}';
        final rawMeta = op['metadata'] as Map?;
        parts[uploadId] = <int, Uint8List>{};
        pending[uploadId] = <String, dynamic>{
          'bucket': bucket,
          'path': op['path'] as String,
          'contentType': (op['contentType'] as String?) ??
              (rawMeta?['contentType'] as String?) ??
              'application/octet-stream',
        };
        _replyOk(id, <String, dynamic>{
          'uploadId': uploadId,
          'uploadUrl': '/__pyric/storage/v0/b/$bucket/o?upload_id=$uploadId',
        });
        return;

      case 'storage.putPart':
        final uploadId = op['uploadId'] as String;
        final idx = (op['partIndex'] as num).toInt();
        final data = Uint8List.fromList(base64Decode(op['dataB64'] as String));
        parts[uploadId]?[idx] = data;
        _replyOk(id, <String, dynamic>{'bytesTransferred': data.length});
        return;

      case 'storage.finishUpload':
        final uploadId = op['uploadId'] as String;
        final info = pending.remove(uploadId)!;
        final staged = parts.remove(uploadId)!;
        final indices = staged.keys.toList()..sort();
        final builder = BytesBuilder(copy: false);
        for (final idx in indices) {
          builder.add(staged[idx]!);
        }
        final bytes = builder.takeBytes();
        final b = info['bucket'] as String;
        final path = info['path'] as String;
        objects['$b|$path'] = bytes;
        final meta = <String, dynamic>{
          'bucket': b,
          'fullPath': path,
          'name': path.split('/').last,
          'size': bytes.length,
          'generation': '${++_counter}',
          'metageneration': '1',
          'contentType': info['contentType'],
          'timeCreated': '2026-11-21T06:00:00.000Z',
          'updated': '2026-11-21T06:00:00.000Z',
        };
        metadata['$b|$path'] = meta;
        _replyOk(id, meta);
        return;

      case 'storage.abortUpload':
        final uploadId = op['uploadId'] as String;
        pending.remove(uploadId);
        parts.remove(uploadId);
        _replyOk(id, null);
        return;

      case 'storage.getMetadata':
        final path = op['path'] as String;
        final meta = metadata['$bucket|$path'];
        if (meta == null) {
          _replyFail(id, 'storage/object-not-found', 'Missing "$path".');
          return;
        }
        _replyOk(id, meta);
        return;

      case 'storage.getBytes':
        final path = op['path'] as String;
        final stored = objects['$bucket|$path'];
        final meta = metadata['$bucket|$path'];
        if (stored == null || meta == null) {
          _replyFail(id, 'storage/object-not-found', 'Missing "$path".');
          return;
        }
        final offset = (op['offset'] as num?)?.toInt() ?? 0;
        final length =
            (op['length'] as num?)?.toInt() ?? (stored.length - offset);
        final end = (offset + length) <= stored.length
            ? (offset + length)
            : stored.length;
        final slice = Uint8List.sublistView(stored, offset, end);
        _replyOk(id, <String, dynamic>{
          'dataB64': base64Encode(slice),
          'contentType': meta['contentType'],
          'size': slice.length,
          'generation': meta['generation'],
        });
        return;
    }
  }

  void _replyOk(String id, Object? value) {
    bridge.current.deliver(<String, dynamic>{
      'type': 'worker-res',
      'id': id,
      'ok': true,
      'value': value,
    });
  }

  void _replyFail(String id, String code, String message) {
    bridge.current.deliver(<String, dynamic>{
      'type': 'worker-res',
      'id': id,
      'ok': false,
      'error': <String, String>{'code': code, 'message': message},
    });
  }
}

Future<Directory> _createScratchTestDir() async {
  final base = Directory('.dart_tool/pyric_storage_file_test_scratch');
  if (!await base.exists()) {
    await base.create(recursive: true);
  }
  return base.createTemp('case_');
}

void main() {
  late FakeBridge fakeBridge;
  late PyricBridgeClient client;
  late PyricFirebaseStoragePlatform storage;

  setUp(() {
    fakeBridge = FakeBridge();
    _FileAndBlobBridgeServer(fakeBridge);
    client = PyricBridgeClient(channelFactory: fakeBridge.connect);
    storage = PyricFirebaseStoragePlatform(
      bucket: 'demo-bucket',
      bridgeClient: client,
      taskChunkSize: 1024,
    );
  });

  tearDown(() async {
    await storage.dispose();
    await client.disconnect();
    await PyricFirebaseStoragePlatform.clearInstancesForTest();
  });

  group('putBlob, putFile, writeToFile, and root-reference guards', () {
    test('putBlob supports Uint8List, List<int>, ByteBuffer, String, Stream<List<int>>, and File', () async {
      final scratchDir = await _createScratchTestDir();
      final blobFile = File('${scratchDir.path}/blob_file.bin');
      try {
        await blobFile.writeAsBytes(const <int>[21, 22, 23], flush: true);

        final r1 = storage.ref('blobs/bytes.bin');
        await r1.putBlob(Uint8List.fromList(<int>[1, 2, 3])).onComplete;
        expect(await r1.getData(64), equals(Uint8List.fromList(<int>[1, 2, 3])));

        final r2 = storage.ref('blobs/list.bin');
        await r2.putBlob(<int>[4, 5, 6]).onComplete;
        expect(await r2.getData(64), equals(Uint8List.fromList(<int>[4, 5, 6])));

        final r3 = storage.ref('blobs/buffer.bin');
        await r3.putBlob(Uint8List.fromList(<int>[7, 8]).buffer).onComplete;
        expect(await r3.getData(64), equals(Uint8List.fromList(<int>[7, 8])));

        final r4 = storage.ref('blobs/string.txt');
        await r4.putBlob('hello blob').onComplete;
        expect(utf8.decode((await r4.getData(64))!), equals('hello blob'));

        final r5 = storage.ref('blobs/stream.bin');
        final byteStream = Stream<List<int>>.fromIterable(<List<int>>[
          <int>[9, 10],
          <int>[11, 12],
        ]);
        await r5.putBlob(byteStream).onComplete;
        expect(
          await r5.getData(64),
          equals(Uint8List.fromList(<int>[9, 10, 11, 12])),
        );

        final r6 = storage.ref('blobs/file.bin');
        await r6.putBlob(blobFile).onComplete;
        expect(
          await r6.getData(64),
          equals(Uint8List.fromList(<int>[21, 22, 23])),
        );

        expect(
          () => storage.ref('blobs/null.bin').putBlob(null),
          throwsA(
            isA<FirebaseException>()
                .having((e) => e.code, 'code', 'invalid-argument'),
          ),
        );
        expect(
          () => storage.ref('blobs/bad.bin').putBlob(42),
          throwsA(
            isA<FirebaseException>()
                .having((e) => e.code, 'code', 'invalid-argument'),
          ),
        );
      } finally {
        if (await blobFile.exists()) {
          await blobFile.delete();
        }
        if (await scratchDir.exists()) {
          await scratchDir.delete();
        }
      }
    });

    test('putFile and writeToFile round-trip multi-chunk files, overwrite targets, and surface missing-file errors', () async {
      final scratchDir = await _createScratchTestDir();
      final srcFile = File('${scratchDir.path}/source.bin');
      final dstFile = File('${scratchDir.path}/downloaded.bin');
      final missingFile = File('${scratchDir.path}/does_not_exist.bin');

      try {
        final content = Uint8List.fromList(
          List<int>.generate(2600, (int i) => (i * 7 + 3) & 0xff),
        );
        await srcFile.writeAsBytes(content, flush: true);
        await dstFile.writeAsBytes(const <int>[99, 99], flush: true);

        final ref = storage.ref('files/roundtrip.bin');
        final uploadSnap = await ref
            .putFile(
              srcFile,
              SettableMetadata(contentType: 'application/octet-stream'),
            )
            .onComplete;
        expect(uploadSnap.state, equals(TaskState.success));
        expect(uploadSnap.bytesTransferred, equals(2600));

        final downloadEvents = await ref.writeToFile(dstFile).snapshotEvents.toList();
        expect(downloadEvents.last.state, equals(TaskState.success));
        expect(downloadEvents.last.bytesTransferred, equals(2600));
        expect(await dstFile.readAsBytes(), equals(content));

        final missingTask = storage.ref('files/missing.bin').putFile(missingFile);
        await expectLater(
          missingTask.onComplete,
          throwsA(
            isA<FirebaseException>()
                .having((e) => e.plugin, 'plugin', 'firebase_storage'),
          ),
        );
        expect(missingTask.snapshot.state, equals(TaskState.error));
      } finally {
        if (await srcFile.exists()) {
          await srcFile.delete();
        }
        if (await dstFile.exists()) {
          await dstFile.delete();
        }
        if (await scratchDir.exists()) {
          await scratchDir.delete();
        }
      }
    });

    test('root reference rejects putData, putBlob, putString, putFile, and writeToFile synchronously', () {
      final root = storage.ref('/');
      expect(
        () => root.putData(Uint8List(1)),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.code, 'code', 'invalid-root-operation'),
        ),
      );
      expect(
        () => root.putBlob(Uint8List(1)),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.code, 'code', 'invalid-root-operation'),
        ),
      );
      expect(
        () => root.putString('hi', PutStringFormat.raw),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.code, 'code', 'invalid-root-operation'),
        ),
      );
      expect(
        () => root.putFile(File('ignored.bin')),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.code, 'code', 'invalid-root-operation'),
        ),
      );
      expect(
        () => root.writeToFile(File('ignored.bin')),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.code, 'code', 'invalid-root-operation'),
        ),
      );
    });
  });
}
