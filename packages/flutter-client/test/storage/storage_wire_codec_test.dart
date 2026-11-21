import 'package:firebase_core/firebase_core.dart' show FirebaseException;
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_storage.dart';

void main() {
  group('storage_wire_codec error normalization', () {
    test('strips storage/ prefixes and maps bridge/sandbox codes to FlutterFire codes', () {
      expect(normalizeStorageErrorCode('storage/object-not-found'), equals('object-not-found'));
      expect(normalizeStorageErrorCode('not-found'), equals('object-not-found'));
      expect(normalizeStorageErrorCode('storage/unauthorized'), equals('unauthorized'));
      expect(normalizeStorageErrorCode('permission-denied'), equals('unauthorized'));
      expect(normalizeStorageErrorCode('PERMISSION_DENIED'), equals('unauthorized'));
      expect(normalizeStorageErrorCode('storage/unauthenticated'), equals('unauthenticated'));
      expect(normalizeStorageErrorCode('storage/canceled'), equals('canceled'));
      expect(normalizeStorageErrorCode('cancelled'), equals('canceled'));
      expect(normalizeStorageErrorCode('storage/quota-exceeded'), equals('quota-exceeded'));
      expect(normalizeStorageErrorCode('payload-too-large'), equals('quota-exceeded'));
      expect(normalizeStorageErrorCode('resource-exhausted'), equals('quota-exceeded'));
      expect(normalizeStorageErrorCode('storage/bucket-not-found'), equals('bucket-not-found'));
      expect(normalizeStorageErrorCode('storage/project-not-found'), equals('project-not-found'));
      expect(normalizeStorageErrorCode('storage/invalid-checksum'), equals('invalid-checksum'));
      expect(normalizeStorageErrorCode('storage/retry-limit-exceeded'), equals('retry-limit-exceeded'));
      expect(normalizeStorageErrorCode('deadline-exceeded'), equals('retry-limit-exceeded'));
      expect(normalizeStorageErrorCode('storage/object-changed'), equals('retry-limit-exceeded'));
      expect(normalizeStorageErrorCode('storage/invalid-url'), equals('invalid-url'));
      expect(normalizeStorageErrorCode('storage/invalid-argument'), equals('invalid-argument'));
      expect(normalizeStorageErrorCode('storage/no-default-bucket'), equals('no-default-bucket'));
      expect(normalizeStorageErrorCode('storage/cannot-slice-blob'), equals('cannot-slice-blob'));
      expect(normalizeStorageErrorCode('storage/server-file-wrong-size'), equals('server-file-wrong-size'));
      expect(normalizeStorageErrorCode('storage/download-size-exceeded'), equals('download-size-exceeded'));
      expect(normalizeStorageErrorCode('storage/invalid-root-operation'), equals('invalid-root-operation'));
      expect(normalizeStorageErrorCode('storage/unknown'), equals('unknown'));
      expect(normalizeStorageErrorCode('   '), equals('unknown'));
    });

    test('maps HTTP byte-route status codes to FirebaseException codes', () {
      expect(mapHttpStatusToStorageException(401, 'a/b.txt').code, equals('unauthenticated'));
      expect(mapHttpStatusToStorageException(403, 'a/b.txt').code, equals('unauthorized'));
      expect(mapHttpStatusToStorageException(404, 'a/b.txt').code, equals('object-not-found'));
      expect(mapHttpStatusToStorageException(413, 'a/b.txt').code, equals('quota-exceeded'));
      expect(mapHttpStatusToStorageException(502, 'a/b.txt', 'bad gateway').code, equals('unknown'));
    });

    test('wraps PyricBridgeException, foreign FirebaseException, and generic errors cleanly', () {
      const bridgeErr = PyricBridgeException(
        code: 'storage/object-not-found',
        message: 'Object missing.',
      );
      final mapped = mapToStorageFirebaseException(bridgeErr);
      expect(mapped.plugin, equals('firebase_storage'));
      expect(mapped.code, equals('object-not-found'));
      expect(mapped.message, equals('Object missing.'));

      final existingStorageErr = FirebaseException(
        plugin: 'firebase_storage',
        code: 'unauthorized',
        message: 'Denied.',
      );
      expect(identical(mapToStorageFirebaseException(existingStorageErr), existingStorageErr), isTrue);

      final foreignFirebaseErr = FirebaseException(
        plugin: 'other_plugin',
        code: 'permission-denied',
        message: 'Foreign denial.',
      );
      final normalizedForeign = mapToStorageFirebaseException(foreignFirebaseErr);
      expect(normalizedForeign.plugin, equals('firebase_storage'));
      expect(normalizedForeign.code, equals('unauthorized'));

      final fallback = mapToStorageFirebaseException(StateError('unexpected'));
      expect(fallback.plugin, equals('firebase_storage'));
      expect(fallback.code, equals('unknown'));
      expect(fallback.message, contains('unexpected'));
    });
  });

  group('storage_wire_codec bucket, path, and URL parsing', () {
    test('normalizes gs:// and bare bucket specs and rejects object paths in bucket specs', () {
      expect(normalizeStorageBucketSpec(''), equals(''));
      expect(normalizeStorageBucketSpec('  demo.appspot.com  '), equals('demo.appspot.com'));
      expect(normalizeStorageBucketSpec('gs://demo.appspot.com'), equals('demo.appspot.com'));
      expect(normalizeStorageBucketSpec('gs://demo.appspot.com/'), equals('demo.appspot.com'));

      for (final invalid in <String>[
        'gs://',
        'gs:///',
        'gs://demo.appspot.com/subpath',
        'https://demo.appspot.com',
        'demo.appspot.com/sub',
      ]) {
        expect(
          () => normalizeStorageBucketSpec(invalid),
          throwsA(
            isA<FirebaseException>()
                .having((e) => e.plugin, 'plugin', 'firebase_storage')
                .having((e) => e.code, 'code', 'invalid-url'),
          ),
          reason: 'Expected invalid-url for "$invalid"',
        );
      }
    });

    test('normalizes leading, trailing, and repeated slashes in wire and pointer paths', () {
      expect(normalizeStorageWirePath(null), equals(''));
      expect(normalizeStorageWirePath(''), equals(''));
      expect(normalizeStorageWirePath('/'), equals(''));
      expect(normalizeStorageWirePath('////'), equals(''));
      expect(normalizeStorageWirePath('/users//u1///avatar.png/'), equals('users/u1/avatar.png'));

      expect(normalizeStoragePointerPath(null), equals('/'));
      expect(normalizeStoragePointerPath(''), equals('/'));
      expect(normalizeStoragePointerPath('///'), equals('/'));
      expect(normalizeStoragePointerPath('/users//u1/avatar.png/'), equals('users/u1/avatar.png'));
    });

    test('parses gs://, Firebase REST, Pyric HTTP byte-route, and GCS URLs', () {
      final gsRoot = parseStorageUrlLocation('gs://media-bucket');
      expect(gsRoot.bucket, equals('media-bucket'));
      expect(gsRoot.path, equals(''));

      final gsObject = parseStorageUrlLocation('gs://media-bucket//albums/cover.jpg/');
      expect(gsObject.bucket, equals('media-bucket'));
      expect(gsObject.path, equals('albums/cover.jpg'));

      final firebaseHttp = parseStorageUrlLocation(
        'https://firebasestorage.googleapis.com/v0/b/my-app.appspot.com/o/docs%2Fannual%20report.pdf?alt=media&token=t1',
      );
      expect(firebaseHttp.bucket, equals('my-app.appspot.com'));
      expect(firebaseHttp.path, equals('docs/annual report.pdf'));

      final firebaseUploadQuery = parseStorageUrlLocation(
        'https://firebasestorage.googleapis.com/v0/b/my-app.appspot.com/o?name=uploads/clip.mp4',
      );
      expect(firebaseUploadQuery.bucket, equals('my-app.appspot.com'));
      expect(firebaseUploadQuery.path, equals('uploads/clip.mp4'));

      final pyricRoute = parseStorageUrlLocation(
        'http://127.0.0.1:5174/__pyric/storage/v0/b/custom-bucket/o/users%2Fu42%2Fnote.txt?alt=media&token=9f2d',
      );
      expect(pyricRoute.bucket, equals('custom-bucket'));
      expect(pyricRoute.path, equals('users/u42/note.txt'));

      final gcsPathStyle = parseStorageUrlLocation(
        'https://storage.googleapis.com/archive-bucket/2026/summary%20v1.json',
      );
      expect(gcsPathStyle.bucket, equals('archive-bucket'));
      expect(gcsPathStyle.path, equals('2026/summary v1.json'));

      final gcsSubdomain = parseStorageUrlLocation(
        'https://assets-bucket.storage.googleapis.com/icons/logo.svg',
      );
      expect(gcsSubdomain.bucket, equals('assets-bucket'));
      expect(gcsSubdomain.path, equals('icons/logo.svg'));

      expect(
        () => parseStorageUrlLocation('relative/path/only.txt'),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.plugin, 'plugin', 'firebase_storage')
              .having((e) => e.code, 'code', 'invalid-argument'),
        ),
      );
      expect(
        () => parseStorageUrlLocation('https://example.com/not-a-storage-path'),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.plugin, 'plugin', 'firebase_storage')
              .having((e) => e.code, 'code', 'invalid-url'),
        ),
      );
    });
  });

  group('storage_wire_codec metadata and pagination codecs', () {
    test('decodes wire FullMetadata ISO timestamps, metageneration aliases, and customMetadata', () {
      final decoded = decodeWireFullMetadata(
        <String, Object?>{
          'bucket': 'demo-bucket',
          'fullPath': 'photos/2026/sunset.png',
          'name': 'sunset.png',
          'size': 4096,
          'generation': '7',
          'metageneration': '3',
          'md5Hash': '1B2M2Y8AsgTpgAmY7PhCfg==',
          'contentType': 'image/png',
          'cacheControl': 'public, max-age=3600',
          'contentDisposition': 'inline',
          'contentEncoding': 'identity',
          'contentLanguage': 'en-US',
          'timeCreated': '2026-05-01T12:00:00.000Z',
          'updated': '2026-05-01T12:30:00.000Z',
          'customMetadata': <String, Object?>{'author': 'ada', 'revision': 2},
        },
      );

      expect(decoded.bucket, equals('demo-bucket'));
      expect(decoded.fullPath, equals('photos/2026/sunset.png'));
      expect(decoded.name, equals('sunset.png'));
      expect(decoded.size, equals(4096));
      expect(decoded.generation, equals('7'));
      expect(decoded.metageneration, equals('3'));
      expect(decoded.metadataGeneration, equals('3'));
      expect(decoded.md5Hash, equals('1B2M2Y8AsgTpgAmY7PhCfg=='));
      expect(decoded.contentType, equals('image/png'));
      expect(decoded.cacheControl, equals('public, max-age=3600'));
      expect(decoded.contentDisposition, equals('inline'));
      expect(decoded.contentEncoding, equals('identity'));
      expect(decoded.contentLanguage, equals('en-US'));
      expect(decoded.timeCreated, equals(DateTime.parse('2026-05-01T12:00:00.000Z').toLocal()));
      expect(decoded.updated, equals(DateTime.parse('2026-05-01T12:30:00.000Z').toLocal()));
      expect(decoded.customMetadata, equals(<String, String>{'author': 'ada', 'revision': '2'}));
    });

    test('encodes SettableMetadata and StorageMetadataPatchWire with null tombstones for removed custom keys', () {
      expect(encodeWireSettableMetadata(null), isNull);

      final settable = SettableMetadata(
        contentType: 'text/markdown',
        cacheControl: '',
        customMetadata: <String, String>{'keep': 'yes', 'added': '1'},
      );
      final wireUpload = encodeWireSettableMetadata(settable)!;
      expect(wireUpload['contentType'], equals('text/markdown'));
      expect(wireUpload['cacheControl'], equals(''));
      expect(wireUpload['customMetadata'], equals(<String, String>{'keep': 'yes', 'added': '1'}));

      final patch = encodeWireMetadataPatch(
        settable,
        existingCustomMetadata: const <String, String>{'keep': 'old', 'removed': 'bye'},
      );
      expect(
        patch['settable'],
        equals(<String, Object?>{
          'contentType': 'text/markdown',
          'cacheControl': null,
        }),
      );
      expect(
        patch['customMetadata'],
        equals(<String, String?>{
          'removed': null,
          'keep': 'yes',
          'added': '1',
        }),
      );
    });

    test('round-trips list pageTokens and rejects malformed cursors with invalid-argument', () {
      final token = encodeStorageListPageToken(25);
      expect(decodeStorageListPageToken(token), equals(25));

      for (final bad in <String>['', 'not-base64!!!', 'e30=', 'eyJvIjotMX0=']) {
        expect(
          () => decodeStorageListPageToken(bad),
          throwsA(
            isA<FirebaseException>()
                .having((e) => e.plugin, 'plugin', 'firebase_storage')
                .having((e) => e.code, 'code', 'invalid-argument'),
          ),
        );
      }
    });
  });
}
