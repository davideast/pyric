import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_storage.dart';

import '../helpers/fake_bridge.dart';

Map<String, dynamic> _fakeMetadataWire({
  required String bucket,
  required String fullPath,
  required int size,
  String contentType = 'application/octet-stream',
  String generation = '1',
  String metageneration = '1',
  Map<String, String>? customMetadata,
  String? rollbackToken,
}) {
  final name = fullPath.contains('/') ? fullPath.split('/').last : fullPath;
  return <String, dynamic>{
    'bucket': bucket,
    'fullPath': fullPath,
    'name': name,
    'size': size,
    'generation': generation,
    'metageneration': metageneration,
    'md5Hash': 'fakeMd5Hash==',
    'contentType': contentType,
    'timeCreated': '2026-11-21T06:00:00.000Z',
    'updated': '2026-11-21T06:00:01.000Z',
    if (customMetadata != null) 'customMetadata': customMetadata,
    if (rollbackToken != null) 'rollbackToken': rollbackToken,
  };
}

class _InMemoryChunkedBridgeResponder {
  final FakeBridge bridge;
  static const String defaultBucket = 'demo-bucket';
  final Map<String, Uint8List> objects = <String, Uint8List>{};
  final Map<String, Map<String, dynamic>> objectMeta =
      <String, Map<String, dynamic>>{};
  final Map<String, Map<int, Uint8List>> stagedParts =
      <String, Map<int, Uint8List>>{};
  final Map<String, Map<String, dynamic>> pendingUploads =
      <String, Map<String, dynamic>>{};
  final List<String> abortedUploadIds = <String>[];
  final List<String> rolledBackTokens = <String>[];
  final List<Map<String, dynamic>> recordedOps = <Map<String, dynamic>>[];

  int _uploadCounter = 0;
  int _generationCounter = 0;

  Future<void> Function(String method, Map<String, dynamic> op)? beforeReply;
  Map<String, String>? Function(String method, Map<String, dynamic> op)?
      failWith;

  _InMemoryChunkedBridgeResponder(this.bridge) {
    bridge.onFrame = (Map<String, dynamic> frame) {
      if (frame['type'] != 'worker-op') {
        return;
      }
      final id = frame['id'] as String;
      final op = Map<String, dynamic>.from(frame['op'] as Map);
      recordedOps.add(op);
      unawaited(_handleOp(id, op));
    };
  }

  Future<void> _handleOp(String id, Map<String, dynamic> op) async {
    final method = op['method'] as String;
    if (beforeReply != null) {
      await beforeReply!(method, op);
    }
    final forcedFailure = failWith?.call(method, op);
    if (forcedFailure != null) {
      bridge.current.deliver(<String, dynamic>{
        'type': 'worker-res',
        'id': id,
        'ok': false,
        'error': forcedFailure,
      });
      return;
    }

    switch (method) {
      case 'storage.beginUpload':
        final uploadId = 'up-${++_uploadCounter}';
        final bucket = (op['bucket'] as String?) ??
            (op['defaultBucket'] as String?) ??
            defaultBucket;
        final path = op['path'] as String;
        final size = (op['size'] as num).toInt();
        final rawMeta = op['metadata'] as Map?;
        final contentType = (op['contentType'] as String?) ??
            (rawMeta?['contentType'] as String?) ??
            'application/octet-stream';
        Map<String, String>? customMetadata;
        if (rawMeta != null && rawMeta['customMetadata'] is Map) {
          customMetadata =
              Map<String, String>.from(rawMeta['customMetadata'] as Map);
        }
        stagedParts[uploadId] = <int, Uint8List>{};
        pendingUploads[uploadId] = <String, dynamic>{
          'bucket': bucket,
          'path': path,
          'size': size,
          'contentType': contentType,
          'customMetadata': customMetadata,
        };
        bridge.current.deliver(<String, dynamic>{
          'type': 'worker-res',
          'id': id,
          'ok': true,
          'value': <String, dynamic>{
            'uploadId': uploadId,
            'uploadUrl':
                '/__pyric/storage/v0/b/$bucket/o?name=${Uri.encodeQueryComponent(path)}&upload_id=$uploadId&upload_token=tok-$uploadId',
          },
        });
        return;

      case 'storage.putPart':
        final uploadId = op['uploadId'] as String;
        final partIndex = (op['partIndex'] as num).toInt();
        final bytes = Uint8List.fromList(base64Decode(op['dataB64'] as String));
        stagedParts[uploadId]?[partIndex] = bytes;
        bridge.current.deliver(<String, dynamic>{
          'type': 'worker-res',
          'id': id,
          'ok': true,
          'value': <String, dynamic>{'bytesTransferred': bytes.length},
        });
        return;

      case 'storage.finishUpload':
        final uploadId = op['uploadId'] as String;
        final pending = pendingUploads.remove(uploadId);
        final parts = stagedParts.remove(uploadId);
        if (pending == null || parts == null) {
          bridge.current.deliver(<String, dynamic>{
            'type': 'worker-res',
            'id': id,
            'ok': false,
            'error': <String, String>{
              'code': 'storage/object-not-found',
              'message': 'Upload not found.',
            },
          });
          return;
        }
        final sortedIndices = parts.keys.toList()..sort();
        final builder = BytesBuilder(copy: false);
        for (final idx in sortedIndices) {
          builder.add(parts[idx]!);
        }
        final assembled = builder.takeBytes();
        final bucket = pending['bucket'] as String;
        final path = pending['path'] as String;
        final key = '$bucket|$path';
        final gen = '${++_generationCounter}';
        final wantsRollback = op['rollback'] == true;
        final rollbackToken = wantsRollback ? 'rb-$uploadId' : null;
        objects[key] = assembled;
        final meta = _fakeMetadataWire(
          bucket: bucket,
          fullPath: path,
          size: assembled.length,
          contentType: pending['contentType'] as String,
          generation: gen,
          customMetadata: pending['customMetadata'] as Map<String, String>?,
          rollbackToken: rollbackToken,
        );
        objectMeta[key] = meta;
        bridge.current.deliver(<String, dynamic>{
          'type': 'worker-res',
          'id': id,
          'ok': true,
          'value': meta,
        });
        return;

      case 'storage.abortUpload':
        final uploadId = op['uploadId'] as String;
        abortedUploadIds.add(uploadId);
        pendingUploads.remove(uploadId);
        stagedParts.remove(uploadId);
        bridge.current.deliver(<String, dynamic>{
          'type': 'worker-res',
          'id': id,
          'ok': true,
          'value': null,
        });
        return;

      case 'storage.rollbackUpload':
        final token = op['rollbackToken'] as String;
        rolledBackTokens.add(token);
        final targetEntries = objectMeta.entries
            .where((e) => e.value['rollbackToken'] == token)
            .map((e) => e.key)
            .toList();
        for (final key in targetEntries) {
          objects.remove(key);
          objectMeta.remove(key);
        }
        bridge.current.deliver(<String, dynamic>{
          'type': 'worker-res',
          'id': id,
          'ok': true,
          'value': <String, dynamic>{'deleted': true, 'restored': false},
        });
        return;

      case 'storage.getMetadata':
        final bucket = (op['bucket'] as String?) ??
            (op['defaultBucket'] as String?) ??
            defaultBucket;
        final path = op['path'] as String;
        final meta = objectMeta['$bucket|$path'];
        if (meta == null) {
          bridge.current.deliver(<String, dynamic>{
            'type': 'worker-res',
            'id': id,
            'ok': false,
            'error': <String, String>{
              'code': 'storage/object-not-found',
              'message': 'Object "$path" does not exist.',
            },
          });
          return;
        }
        bridge.current.deliver(<String, dynamic>{
          'type': 'worker-res',
          'id': id,
          'ok': true,
          'value': meta,
        });
        return;

      case 'storage.getBytes':
        final bucket = (op['bucket'] as String?) ??
            (op['defaultBucket'] as String?) ??
            defaultBucket;
        final path = op['path'] as String;
        final stored = objects['$bucket|$path'];
        final meta = objectMeta['$bucket|$path'];
        if (stored == null || meta == null) {
          bridge.current.deliver(<String, dynamic>{
            'type': 'worker-res',
            'id': id,
            'ok': false,
            'error': <String, String>{
              'code': 'storage/object-not-found',
              'message': 'Object "$path" does not exist.',
            },
          });
          return;
        }
        final offset = (op['offset'] as num?)?.toInt() ?? 0;
        final length =
            (op['length'] as num?)?.toInt() ?? (stored.length - offset);
        final end = (offset + length) <= stored.length
            ? (offset + length)
            : stored.length;
        final slice = Uint8List.sublistView(stored, offset, end);
        bridge.current.deliver(<String, dynamic>{
          'type': 'worker-res',
          'id': id,
          'ok': true,
          'value': <String, dynamic>{
            'dataB64': base64Encode(slice),
            'contentType': meta['contentType'],
            'size': slice.length,
            'generation': meta['generation'],
          },
        });
        return;
    }
  }
}

void main() {
  late FakeBridge fakeBridge;
  late _InMemoryChunkedBridgeResponder responder;
  late PyricBridgeClient client;
  late PyricFirebaseStoragePlatform storage;

  setUp(() {
    fakeBridge = FakeBridge();
    responder = _InMemoryChunkedBridgeResponder(fakeBridge);
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

  group('PyricTaskPlatform & chunked resumable upload lifecycle', () {
    test('putData streams multi-chunk progress snapshots, closes stream, and resolves metadata', () async {
      final payload = Uint8List.fromList(
        List<int>.generate(2500, (int i) => i % 251),
      );
      final ref = storage.ref('uploads/multi.bin');
      final task = ref.putData(
        payload,
        SettableMetadata(
          contentType: 'application/octet-stream',
          customMetadata: const <String, String>{'tag': 'v1'},
        ),
      );

      expect(task.snapshot.state, equals(TaskState.running));
      expect(task.snapshot.bytesTransferred, equals(0));
      expect(task.snapshot.totalBytes, equals(2500));
      expect(task.snapshot.ref.fullPath, equals('uploads/multi.bin'));

      final events = await task.snapshotEvents.toList();
      final finalSnap = await task.onComplete;

      expect(events.isNotEmpty, isTrue);
      expect(events.first.state, equals(TaskState.running));
      expect(events.last.state, equals(TaskState.success));
      expect(events.last.bytesTransferred, equals(2500));
      expect(events.last.totalBytes, equals(2500));

      final transferredSteps =
          events.map((TaskSnapshotPlatform e) => e.bytesTransferred).toList();
      for (var i = 1; i < transferredSteps.length; i += 1) {
        expect(
          transferredSteps[i],
          greaterThanOrEqualTo(transferredSteps[i - 1]),
        );
      }
      expect(transferredSteps, containsAllInOrder(<int>[0, 1024, 2048, 2500]));

      expect(finalSnap.state, equals(TaskState.success));
      expect(finalSnap.metadata, isNotNull);
      expect(finalSnap.metadata!.size, equals(2500));
      expect(finalSnap.metadata!.contentType, equals('application/octet-stream'));
      expect(
        finalSnap.metadata!.customMetadata,
        equals(<String, String>{'tag': 'v1'}),
      );
      expect(finalSnap.metadata!.timeCreated, isNotNull);
      expect(finalSnap.metadata!.updated, isNotNull);
      expect(finalSnap.metadata!.metageneration, equals('1'));
      expect(finalSnap.metadata!.metadataGeneration, equals('1'));

      final downloaded = await ref.getData(4096);
      expect(downloaded, equals(payload));

      final partOps = responder.recordedOps
          .where((op) => op['method'] == 'storage.putPart')
          .toList();
      expect(partOps.length, equals(3));
      expect(
        partOps.map((op) => op['partIndex']).toList(),
        equals(<int>[0, 1, 2]),
      );
    });

    test('pause and resume gate multi-chunk upload deterministically with accurate return booleans', () async {
      final payload =
          Uint8List.fromList(List<int>.generate(2400, (i) => i & 0xff));
      final ref = storage.ref('uploads/pausable.bin');

      var part0Completed = false;
      responder.beforeReply = (String method, Map<String, dynamic> op) async {
        if (method == 'storage.putPart' && op['partIndex'] == 0) {
          part0Completed = true;
        }
      };

      final task = ref.putData(payload);
      final states = <TaskState>[];
      final sub = task.snapshotEvents.listen((snap) {
        states.add(snap.state);
      });

      final pausedFirst = await task.pause();
      expect(pausedFirst, isTrue);
      expect(task.snapshot.state, equals(TaskState.paused));
      expect(await task.pause(), isFalse);

      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(part0Completed, isFalse);

      final resumed = await task.resume();
      expect(resumed, isTrue);
      expect(await task.resume(), isFalse);

      final done = await task.onComplete;
      await sub.cancel();

      expect(done.state, equals(TaskState.success));
      expect(done.bytesTransferred, equals(2400));
      expect(states, contains(TaskState.paused));
      expect(states.last, equals(TaskState.success));

      expect(await task.pause(), isFalse);
      expect(await task.resume(), isFalse);
      expect(await task.cancel(), isFalse);
    });

    test('cancel mid-upload aborts server upload, rejects with canceled, and causes zero unhandled errors', () async {
      final payload =
          Uint8List.fromList(List<int>.generate(3000, (i) => i % 127));
      final ref = storage.ref('uploads/cancel-mid.bin');

      final part1Reached = Completer<void>();
      final holdPart1 = Completer<void>();
      responder.beforeReply = (String method, Map<String, dynamic> op) async {
        if (method == 'storage.putPart' && op['partIndex'] == 1) {
          part1Reached.complete();
          await holdPart1.future;
        }
      };

      final task = ref.putData(payload);
      Object? streamError;
      final doneCompleter = Completer<void>();
      task.snapshotEvents.listen(
        (_) {},
        onError: (Object err) {
          streamError = err;
        },
        onDone: doneCompleter.complete,
      );

      await part1Reached.future;
      final cancelOk = await task.cancel();
      holdPart1.complete();

      expect(cancelOk, isTrue);
      expect(await task.cancel(), isFalse);
      expect(task.snapshot.state, equals(TaskState.canceled));

      await doneCompleter.future;
      expect(streamError, isA<FirebaseException>());
      expect((streamError as FirebaseException).code, equals('canceled'));

      await expectLater(
        task.onComplete,
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.plugin, 'plugin', 'firebase_storage')
              .having((e) => e.code, 'code', 'canceled'),
        ),
      );
      expect(responder.abortedUploadIds, equals(<String>['up-1']));

      responder.beforeReply = null;
      final unawaitedTask =
          storage.ref('uploads/cancel-unwatched.bin').putData(payload);
      expect(await unawaitedTask.cancel(), isTrue);
      await Future<void>.delayed(const Duration(milliseconds: 10));
    });

    test('cancel racing in-flight finishUpload redeems rollbackToken via storage.rollbackUpload', () async {
      final payload = Uint8List.fromList(<int>[10, 20, 30, 40]);
      final ref = storage.ref('uploads/cancel-race.bin');

      final finishEntered = Completer<void>();
      final releaseFinish = Completer<void>();
      responder.beforeReply = (String method, Map<String, dynamic> op) async {
        if (method == 'storage.finishUpload') {
          finishEntered.complete();
          await releaseFinish.future;
        }
      };

      final task = ref.putData(payload);
      await finishEntered.future;

      final cancelFuture = task.cancel();
      await Future<void>.delayed(const Duration(milliseconds: 5));
      releaseFinish.complete();

      expect(await cancelFuture, isTrue);
      expect(responder.rolledBackTokens, equals(<String>['rb-up-1']));
      await expectLater(
        ref.getMetadata(),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.code, 'code', 'object-not-found'),
        ),
      );
    });

    test('server unauthorized error transitions task to TaskState.error and aborts staged upload', () async {
      responder.failWith = (String method, Map<String, dynamic> op) {
        if (method == 'storage.putPart') {
          return <String, String>{
            'code': 'storage/unauthorized',
            'message': 'Storage Rules denied write.',
          };
        }
        return null;
      };

      final task = storage
          .ref('uploads/denied.bin')
          .putData(Uint8List.fromList(<int>[1, 2, 3]));
      Object? streamErr;
      task.snapshotEvents.listen((_) {}, onError: (Object e) => streamErr = e);

      await expectLater(
        task.onComplete,
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.plugin, 'plugin', 'firebase_storage')
              .having((e) => e.code, 'code', 'unauthorized'),
        ),
      );
      expect(task.snapshot.state, equals(TaskState.error));
      expect((streamErr as FirebaseException).code, equals('unauthorized'));
      expect(responder.abortedUploadIds, equals(<String>['up-1']));
    });
  });
}
