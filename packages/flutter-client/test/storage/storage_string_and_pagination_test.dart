import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_storage.dart';

import '../helpers/fake_bridge.dart';

class _StatefulStorageFakeServer {
  final FakeBridge bridge;
  final Map<String, Uint8List> bytesByPath = <String, Uint8List>{};
  final Map<String, Map<String, dynamic>> metaByPath =
      <String, Map<String, dynamic>>{};
  final Map<String, Map<int, Uint8List>> partsByUpload =
      <String, Map<int, Uint8List>>{};
  final Map<String, Map<String, dynamic>> pendingByUpload =
      <String, Map<String, dynamic>>{};
  int _seq = 0;

  _StatefulStorageFakeServer(this.bridge) {
    bridge.onFrame = (Map<String, dynamic> frame) {
      if (frame['type'] != 'worker-op') {
        return;
      }
      final id = frame['id'] as String;
      final op = Map<String, dynamic>.from(frame['op'] as Map);
      scheduleMicrotask(() => _dispatch(id, op));
    };
  }

  void _dispatch(String id, Map<String, dynamic> op) {
    final method = op['method'] as String;
    final bucket = (op['bucket'] as String?) ??
        (op['defaultBucket'] as String?) ??
        'demo-bucket';
    switch (method) {
      case 'storage.beginUpload':
        final uploadId = 'u-${++_seq}';
        final rawMeta = op['metadata'] as Map?;
        partsByUpload[uploadId] = <int, Uint8List>{};
        pendingByUpload[uploadId] = <String, dynamic>{
          'bucket': bucket,
          'path': op['path'] as String,
          'contentType': (op['contentType'] as String?) ??
              (rawMeta?['contentType'] as String?) ??
              'application/octet-stream',
          'cacheControl': rawMeta?['cacheControl'],
          'contentDisposition': rawMeta?['contentDisposition'],
          'contentEncoding': rawMeta?['contentEncoding'],
          'contentLanguage': rawMeta?['contentLanguage'],
          'customMetadata': rawMeta?['customMetadata'] is Map
              ? Map<String, String>.from(rawMeta!['customMetadata'] as Map)
              : null,
        };
        _ok(id, <String, dynamic>{
          'uploadId': uploadId,
          'uploadUrl': '/__pyric/storage/v0/b/$bucket/o?upload_id=$uploadId',
        });
        return;

      case 'storage.putPart':
        final uploadId = op['uploadId'] as String;
        final idx = (op['partIndex'] as num).toInt();
        final data = Uint8List.fromList(base64Decode(op['dataB64'] as String));
        partsByUpload[uploadId]?[idx] = data;
        _ok(id, <String, dynamic>{'bytesTransferred': data.length});
        return;

      case 'storage.finishUpload':
        final uploadId = op['uploadId'] as String;
        final pending = pendingByUpload.remove(uploadId)!;
        final parts = partsByUpload.remove(uploadId)!;
        final indices = parts.keys.toList()..sort();
        final builder = BytesBuilder(copy: false);
        for (final i in indices) {
          builder.add(parts[i]!);
        }
        final bytes = builder.takeBytes();
        final path = pending['path'] as String;
        final b = pending['bucket'] as String;
        bytesByPath['$b|$path'] = bytes;
        final meta = <String, dynamic>{
          'bucket': b,
          'fullPath': path,
          'name': path.split('/').last,
          'size': bytes.length,
          'generation': '${++_seq}',
          'metageneration': '1',
          'contentType': pending['contentType'],
          if (pending['cacheControl'] != null)
            'cacheControl': pending['cacheControl'],
          if (pending['contentDisposition'] != null)
            'contentDisposition': pending['contentDisposition'],
          if (pending['contentEncoding'] != null)
            'contentEncoding': pending['contentEncoding'],
          if (pending['contentLanguage'] != null)
            'contentLanguage': pending['contentLanguage'],
          if (pending['customMetadata'] != null)
            'customMetadata': pending['customMetadata'],
          'timeCreated': '2026-11-21T06:00:00.000Z',
          'updated': '2026-11-21T06:00:00.000Z',
        };
        metaByPath['$b|$path'] = meta;
        _ok(id, meta);
        return;

      case 'storage.abortUpload':
        final uploadId = op['uploadId'] as String;
        pendingByUpload.remove(uploadId);
        partsByUpload.remove(uploadId);
        _ok(id, null);
        return;

      case 'storage.getMetadata':
        final path = op['path'] as String;
        final meta = metaByPath['$bucket|$path'];
        if (meta == null) {
          _fail(id, 'storage/object-not-found', 'Missing "$path".');
          return;
        }
        _ok(id, meta);
        return;

      case 'storage.updateMetadata':
      case 'storage.setMetadata':
        final path = op['path'] as String;
        final existing = metaByPath['$bucket|$path'];
        if (existing == null) {
          _fail(id, 'storage/object-not-found', 'Missing "$path".');
          return;
        }
        if (method == 'storage.setMetadata') {
          final actAs = op['actAs'] as Map?;
          if (actAs == null || actAs['mode'] != 'admin') {
            _fail(
              id,
              'storage/unauthorized',
              'storage.setMetadata is the admin plane (firebase-admin File.setMetadata) and runs only on the admin lens.',
            );
            return;
          }
        }
        final patch = Map<String, dynamic>.from(op['patch'] as Map);
        final replaceCustom = op['replaceCustomMetadata'] == true;
        final updated = Map<String, dynamic>.from(existing);
        final settable = patch['settable'] as Map?;
        if (settable != null) {
          settable.forEach((Object? k, Object? v) {
            final key = k.toString();
            if (v == null) {
              updated.remove(key);
            } else {
              updated[key] = v;
            }
          });
        }
        final customPatch = patch['customMetadata'] as Map?;
        if (customPatch != null) {
          final mergedCustom = !replaceCustom && updated['customMetadata'] is Map
              ? Map<String, String>.from(updated['customMetadata'] as Map)
              : <String, String>{};
          customPatch.forEach((Object? k, Object? v) {
            final key = k.toString();
            if (v == null) {
              mergedCustom.remove(key);
            } else {
              mergedCustom[key] = v.toString();
            }
          });
          if (mergedCustom.isEmpty) {
            updated.remove('customMetadata');
          } else {
            updated['customMetadata'] = mergedCustom;
          }
        }
        final nextMetaGen = int.parse(updated['metageneration'] as String) + 1;
        updated['metageneration'] = '$nextMetaGen';
        updated['updated'] = '2026-11-21T06:05:00.000Z';
        metaByPath['$bucket|$path'] = updated;
        _ok(id, updated);
        return;

      case 'storage.getBytes':
        final path = op['path'] as String;
        final bytes = bytesByPath['$bucket|$path'];
        final meta = metaByPath['$bucket|$path'];
        if (bytes == null || meta == null) {
          _fail(id, 'storage/object-not-found', 'Missing "$path".');
          return;
        }
        _ok(id, <String, dynamic>{
          'dataB64': base64Encode(bytes),
          'contentType': meta['contentType'],
          'size': bytes.length,
          'generation': meta['generation'],
        });
        return;

      case 'storage.listAll':
        final prefixPath = op['path'] as String;
        final scanPrefix = prefixPath.isEmpty ? '' : '$prefixPath/';
        final itemPaths = <String>[];
        final subPrefixes = <String>{};
        for (final key in metaByPath.keys) {
          if (!key.startsWith('$bucket|')) continue;
          final full = key.substring('$bucket|'.length);
          if (scanPrefix.isNotEmpty && !full.startsWith(scanPrefix)) continue;
          final relative =
              scanPrefix.isEmpty ? full : full.substring(scanPrefix.length);
          if (relative.isEmpty) continue;
          final slash = relative.indexOf('/');
          if (slash == -1) {
            itemPaths.add(full);
          } else {
            final childFolder = relative.substring(0, slash);
            subPrefixes.add(
              scanPrefix.isEmpty ? childFolder : '$scanPrefix$childFolder',
            );
          }
        }
        itemPaths.sort();
        final sortedPrefixes = subPrefixes.toList()..sort();
        _ok(id, <String, dynamic>{
          'items': itemPaths
              .map((p) => <String, String>{
                    'fullPath': p,
                    'name': p.split('/').last,
                  })
              .toList(),
          'prefixes': sortedPrefixes
              .map((p) => <String, String>{
                    'fullPath': p,
                    'name': p.split('/').last,
                  })
              .toList(),
        });
        return;
    }
  }

  void _ok(String id, Object? value) {
    bridge.current.deliver(<String, dynamic>{
      'type': 'worker-res',
      'id': id,
      'ok': true,
      'value': value,
    });
  }

  void _fail(String id, String code, String message) {
    bridge.current.deliver(<String, dynamic>{
      'type': 'worker-res',
      'id': id,
      'ok': false,
      'error': <String, String>{'code': code, 'message': message},
    });
  }
}

void main() {
  late FakeBridge fakeBridge;
  late PyricBridgeClient client;
  late PyricFirebaseStoragePlatform storage;

  setUp(() {
    fakeBridge = FakeBridge();
    _StatefulStorageFakeServer(fakeBridge);
    client = PyricBridgeClient(channelFactory: fakeBridge.connect);
    storage = PyricFirebaseStoragePlatform(
      bucket: 'demo-bucket',
      bridgeClient: client,
    );
  });

  tearDown(() async {
    await storage.dispose();
    await client.disconnect();
    await PyricFirebaseStoragePlatform.clearInstancesForTest();
  });

  group('putString formats (raw, base64, base64Url, dataUrl)', () {
    test('PutStringFormat.raw uploads UTF-8 bytes with default text/plain; charset=utf-8', () async {
      final ref = storage.ref('strings/raw.txt');
      final snap = await ref
          .putString('Hello Pyric -- UTF-8!', PutStringFormat.raw)
          .onComplete;

      expect(snap.metadata!.contentType, equals('text/plain; charset=utf-8'));
      expect(utf8.decode((await ref.getData(256))!), equals('Hello Pyric -- UTF-8!'));

      final overrideRef = storage.ref('strings/raw-custom.csv');
      final overrideSnap = await overrideRef
          .putString(
            'a,b\n1,2',
            PutStringFormat.raw,
            SettableMetadata(contentType: 'text/csv'),
          )
          .onComplete;
      expect(overrideSnap.metadata!.contentType, equals('text/csv'));
    });

    test('PutStringFormat.base64 and PutStringFormat.base64Url decode padded and unpadded payloads', () async {
      final stdRef = storage.ref('strings/std.bin');
      await stdRef.putString('AQID/w==', PutStringFormat.base64).onComplete;
      expect(
        await stdRef.getData(64),
        equals(Uint8List.fromList(<int>[1, 2, 3, 255])),
      );

      final urlUnpaddedRef = storage.ref('strings/url-unpadded.bin');
      await urlUnpaddedRef
          .putString('-_8BAg', PutStringFormat.base64Url)
          .onComplete;
      expect(
        await urlUnpaddedRef.getData(64),
        equals(Uint8List.fromList(<int>[251, 255, 1, 2])),
      );

      final urlPaddedRef = storage.ref('strings/url-padded.bin');
      await urlPaddedRef
          .putString('-_8=', PutStringFormat.base64Url)
          .onComplete;
      expect(
        await urlPaddedRef.getData(64),
        equals(Uint8List.fromList(<int>[251, 255])),
      );

      // Standard base64 rejects base64url alphabet and vice versa with zero RPCs.
      final opsBefore = fakeBridge.ofType('worker-op').length;
      expect(
        () => stdRef.putString('-_8=', PutStringFormat.base64),
        throwsA(isA<FirebaseException>().having((e) => e.code, 'code', 'invalid-format')),
      );
      expect(
        () => stdRef.putString('AQID/w==', PutStringFormat.base64Url),
        throwsA(isA<FirebaseException>().having((e) => e.code, 'code', 'invalid-format')),
      );
      expect(fakeBridge.ofType('worker-op').length, equals(opsBefore));
    });

    test('PutStringFormat.dataUrl parses base64 and percent-encoded payloads, infers MIME, and rejects malformed inputs', () async {
      final jsonRef = storage.ref('strings/data.json');
      final jsonSnap = await jsonRef
          .putString(
            'data:application/json;base64,eyJvayI6dHJ1ZX0=',
            PutStringFormat.dataUrl,
          )
          .onComplete;
      expect(jsonSnap.metadata!.contentType, equals('application/json'));
      expect(utf8.decode((await jsonRef.getData(128))!), equals('{"ok":true}'));

      final plainRef = storage.ref('strings/plain.txt');
      final plainSnap = await plainRef
          .putString(
            'data:text/plain,hello%20world%21',
            PutStringFormat.dataUrl,
          )
          .onComplete;
      expect(plainSnap.metadata!.contentType, equals('text/plain'));
      expect(utf8.decode((await plainRef.getData(128))!), equals('hello world!'));

      final overrideRef = storage.ref('strings/override.csv');
      final overrideSnap = await overrideRef
          .putString(
            'data:text/plain;base64,YSwx',
            PutStringFormat.dataUrl,
            SettableMetadata(contentType: 'text/csv'),
          )
          .onComplete;
      expect(overrideSnap.metadata!.contentType, equals('text/csv'));
      expect(utf8.decode((await overrideRef.getData(128))!), equals('a,1'));

      final opsBefore = fakeBridge.ofType('worker-op').length;
      for (final bad in <String>[
        'plain-text,hello',
        'data:text/plain;base64',
        'data:text/plain,%ZZ',
        'data:base64,SGVsbG8=',
        'data:text/plain;base64,***',
      ]) {
        expect(
          () => jsonRef.putString(bad, PutStringFormat.dataUrl),
          throwsA(
            isA<FirebaseException>()
                .having((e) => e.plugin, 'plugin', 'firebase_storage')
                .having((e) => e.code, 'code', 'invalid-format'),
          ),
          reason: 'Expected invalid-format for "$bad"',
        );
      }
      expect(fakeBridge.ofType('worker-op').length, equals(opsBefore));
    });
  });

  group('list(ListOptions) pagination and customMetadata update/clear round-trips', () {
    test('list paginates prefixes and items without duplicates or gaps and validates options', () async {
      final folder = storage.ref('catalog');
      for (final sub in <String>[
        'alpha/1.txt',
        'beta/1.txt',
        'item-a.txt',
        'item-b.txt',
        'item-c.txt',
      ]) {
        await folder.child(sub).putString(sub, PutStringFormat.raw).onComplete;
      }

      final seenPrefixes = <String>[];
      final seenItems = <String>[];
      String? pageToken;
      var pageCount = 0;
      do {
        final page = await folder.list(
          ListOptions(maxResults: 2, pageToken: pageToken),
        );
        pageCount += 1;
        expect(page.prefixes.length + page.items.length, lessThanOrEqualTo(2));
        seenPrefixes.addAll(page.prefixes.map((r) => r.fullPath));
        seenItems.addAll(page.items.map((r) => r.fullPath));
        pageToken = page.nextPageToken;
      } while (pageToken != null);

      expect(pageCount, equals(3));
      expect(seenPrefixes, equals(<String>['catalog/alpha', 'catalog/beta']));
      expect(
        seenItems,
        equals(<String>[
          'catalog/item-a.txt',
          'catalog/item-b.txt',
          'catalog/item-c.txt',
        ]),
      );

      await expectLater(
        folder.list(const ListOptions(maxResults: 0)),
        throwsA(isA<FirebaseException>().having((e) => e.code, 'code', 'invalid-argument')),
      );
      await expectLater(
        folder.list(const ListOptions(maxResults: 1001)),
        throwsA(isA<FirebaseException>().having((e) => e.code, 'code', 'invalid-argument')),
      );
      await expectLater(
        folder.list(const ListOptions(pageToken: 'not-a-valid-token!!!')),
        throwsA(isA<FirebaseException>().having((e) => e.code, 'code', 'invalid-argument')),
      );
    });

    test('updateMetadata updates, replaces, and clears customMetadata and scalar headers while preserving bytes', () async {
      final ref = storage.ref('docs/notes.txt');
      final initial = await ref
          .putString(
            'immutable body',
            PutStringFormat.raw,
            SettableMetadata(
              contentType: 'text/plain',
              cacheControl: 'public, max-age=60',
              contentLanguage: 'en',
              customMetadata: const <String, String>{
                'keep': 'yes',
                'drop': 'soon',
              },
            ),
          )
          .onComplete;
      final initialGen = initial.metadata!.generation;
      expect(initial.metadata!.metageneration, equals('1'));

      // Update customMetadata (dropping 'drop' and adding 'stage': '2') while leaving unset headers intact.
      final step1 = await ref.updateMetadata(
        SettableMetadata(
          contentLanguage: 'fr',
          customMetadata: const <String, String>{
            'keep': 'yes',
            'stage': '2',
          },
        ),
      );
      expect(step1.generation, equals(initialGen));
      expect(step1.metageneration, equals('2'));
      expect(step1.cacheControl, equals('public, max-age=60'));
      expect(step1.contentLanguage, equals('fr'));
      expect(
        step1.customMetadata,
        equals(<String, String>{'keep': 'yes', 'stage': '2'}),
      );

      // Clear scalar cacheControl via empty string and clear all customMetadata via empty map {}.
      final step2 = await ref.updateMetadata(
        SettableMetadata(
          cacheControl: '',
          customMetadata: const <String, String>{},
        ),
      );
      expect(step2.generation, equals(initialGen));
      expect(step2.metageneration, equals('3'));
      expect(step2.cacheControl, isNull);
      expect(step2.customMetadata, isNull);
      expect(utf8.decode((await ref.getData(128))!), equals('immutable body'));
    });
  });
}
