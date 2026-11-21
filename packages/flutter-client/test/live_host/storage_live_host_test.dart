import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show Firebase;
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_storage.dart';

import '../storage/storage_live_host_helpers.dart';

void main() {
  final h = LiveStorageHarness();

  setUpAll(h.setUp);
  tearDownAll(h.tearDown);

  group('Pyric Flutter Cloud Storage live-host conformance', () {
    test('storage-live#1: enforces Storage Security Rules against unauthenticated callers', () async {
      if (h.isOffline) {
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

      final storage = h.liveStorage!;
      final lockedRef = storage.ref('users/unauthed/secret.txt');
      await expectStorageExceptionCode(() => lockedRef.getMetadata(), 'unauthorized');
      await expectStorageExceptionCode(() => lockedRef.getDownloadURL(), 'unauthorized');
      await expectStorageExceptionCode(() => storage.ref('users/unauthed').listAll(), 'unauthorized');
      await expectStorageExceptionCode(() => lockedRef.delete(), 'unauthorized');

      if (h.isDedicatedStorageHost) {
        await expectStorageExceptionCode(
          () => storage.uploadBytes(
            'users/unauthed/secret.txt',
            Uint8List.fromList(utf8.encode('blocked')),
          ),
          'unauthorized',
        );
        await expectStorageExceptionCode(() => lockedRef.getData(1024), 'unauthorized');
      }
    });

    test('storage-live#2: authenticates owner and round-trips object bytes with maxSize enforcement', () async {
      if (h.isOffline) {
        final storage = PyricFirebaseStoragePlatform(bucket: 'demo.appspot.com');
        storage.setMaxDownloadRetryTime(90000);
        expect(storage.maxDownloadRetryTime, equals(90000));
        await storage.dispose();
        return;
      }

      if (!h.isDedicatedStorageHost) {
        final adminStorage = h.newAdminStorage();
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

      final credential = await h.liveAuth!.createUserWithEmailAndPassword(
        'storage-owner@example.test',
        'correct-horse-battery-staple',
      );
      h.ownerUid = credential.user!.uid;
      expect(h.ownerUid.isNotEmpty, isTrue);

      final storage = h.liveStorage!;
      final textBytes = Uint8List.fromList(
        utf8.encode('Pyric Flutter Storage live conformance payload'),
      );
      final binBytes = Uint8List.fromList(
        List<int>.generate(512, (index) => (index * 37 + 13) & 0xff),
      );

      final uploadedMeta = await storage.uploadBytes(
        'users/${h.ownerUid}/docs/readme.txt',
        textBytes,
        metadata: SettableMetadata(
          contentType: 'text/plain',
          cacheControl: 'private, max-age=60',
          customMetadata: <String, String>{'stage': 'initial', 'owner': h.ownerUid},
        ),
      );
      expect(uploadedMeta.bucket, equals(h.defaultBucket));
      expect(uploadedMeta.size, equals(textBytes.length));
      expect(uploadedMeta.timeCreated, isNotNull);

      await storage.uploadBytes(
        'users/${h.ownerUid}/docs/sub/binary.bin',
        binBytes,
        metadata: SettableMetadata(contentType: 'application/octet-stream'),
      );

      await expectStorageExceptionCode(
        () => storage.uploadBytes('users/other-uid/docs/intrude.txt', textBytes),
        'unauthorized',
      );

      expect(await storage.ref('users/${h.ownerUid}/docs/readme.txt').getData(1024), equals(textBytes));
      expect(await storage.ref('users/${h.ownerUid}/docs/sub/binary.bin').getData(1024), equals(binBytes));
      await expectStorageExceptionCode(
        () => storage.ref('users/${h.ownerUid}/docs/sub/binary.bin').getData(64),
        'download-size-exceeded',
      );
    });

    test('storage-live#3: reads and patches metadata while preserving generation and enforcing write rules', () async {
      if (h.isOffline) {
        final patch = encodeWireMetadataPatch(
          SettableMetadata(contentType: 'text/markdown', customMetadata: const <String, String>{'k': 'v'}),
          existingCustomMetadata: const <String, String>{'old': '1'},
        );
        expect((patch['customMetadata'] as Map)['old'], isNull);
        return;
      }

      if (!h.isDedicatedStorageHost) {
        final adminStorage = h.newAdminStorage();
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

      final storage = h.liveStorage!;
      final readmeRef = storage.ref('users/${h.ownerUid}/docs/readme.txt');
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

      await expectStorageExceptionCode(
        () => storage.ref('users/other-uid/docs/readme.txt').updateMetadata(
              SettableMetadata(contentType: 'text/plain'),
            ),
        'unauthorized',
      );
    });

    test('storage-live#4: mints persistent HTTP download URLs and round-trips refFromURL', () async {
      if (h.isOffline) {
        final storage = PyricFirebaseStoragePlatform(bucket: 'demo-flutter-live.appspot.com');
        final fromHttp = storage.refFromURL(
          'http://127.0.0.1:5174/__pyric/storage/v0/b/demo-flutter-live.appspot.com/o/users%2Fu1%2Freadme.txt?alt=media&token=t1',
        );
        expect(fromHttp.fullPath, equals('users/u1/readme.txt'));
        await storage.dispose();
        return;
      }

      if (!h.isDedicatedStorageHost) {
        final adminStorage = h.newAdminStorage();
        await adminStorage.uploadBytes('admin-zero/url.bin', Uint8List(0));
        final url = await adminStorage.ref('admin-zero/url.bin').getDownloadURL();
        expect(url, contains('/__pyric/storage/v0/b/'));
        expect(adminStorage.refFromURL(url).fullPath, equals('admin-zero/url.bin'));
        await adminStorage.ref('admin-zero/url.bin').delete();
        await adminStorage.dispose();
        return;
      }

      final storage = h.liveStorage!;
      final readmeRef = storage.ref('users/${h.ownerUid}/docs/readme.txt');
      final downloadUrl = await readmeRef.getDownloadURL();
      expect(
        downloadUrl,
        startsWith('http://${h.bridgeUri!.host}:${h.bridgeUri!.port}/__pyric/storage/v0/b/'),
      );
      expect(downloadUrl, contains('token='));

      final parsedRef = storage.refFromURL(downloadUrl);
      expect(parsedRef.bucket, equals(h.defaultBucket));
      expect(parsedRef.fullPath, equals('users/${h.ownerUid}/docs/readme.txt'));

      final fetched = await fetchLiveHttpUrl(Uri.parse(downloadUrl));
      expect(fetched.statusCode, equals(200));
      expect(fetched.contentType, contains('text/markdown'));
      expect(
        utf8.decode(fetched.body),
        equals('Pyric Flutter Storage live conformance payload'),
      );
    });

    test('storage-live#5: enumerates items and prefixes via listAll and paginated list(ListOptions)', () async {
      if (h.isOffline) {
        final token = encodeStorageListPageToken(3);
        expect(decodeStorageListPageToken(token), equals(3));
        return;
      }

      if (!h.isDedicatedStorageHost) {
        final adminStorage = h.newAdminStorage();
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

      final docsRef = h.liveStorage!.ref('users/${h.ownerUid}/docs');
      final all = await docsRef.listAll();
      expect(
        all.prefixes.map((r) => r.fullPath).toList(),
        equals(<String>['users/${h.ownerUid}/docs/sub']),
      );
      expect(
        all.items.map((r) => r.fullPath).toList(),
        equals(<String>['users/${h.ownerUid}/docs/readme.txt']),
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
      if (h.isOffline) {
        final storage = PyricFirebaseStoragePlatform(bucket: 'gs://flutter-custom-media');
        expect(storage.resolvedBucket, equals('flutter-custom-media'));
        expect(storage.ref('public/banner.txt').toString(), equals('gs://flutter-custom-media/public/banner.txt'));
        await storage.dispose();
        return;
      }

      if (!h.isDedicatedStorageHost) {
        final emulatorStorage = PyricFirebaseStoragePlatform(appInstance: h.liveApp);
        await emulatorStorage.useStorageEmulator(h.bridgeUri!.host, h.bridgeUri!.port);
        await expectStorageExceptionCode(
          () => emulatorStorage.ref('locked/probe.txt').getMetadata(),
          'unauthorized',
        );
        await emulatorStorage.dispose();
        return;
      }

      final storage = h.liveStorage!;
      final customStorage = h.liveCustomStorage!;
      final customPayload = Uint8List.fromList(utf8.encode('custom-bucket-asset'));

      await customStorage.uploadBytes(
        'public/${h.ownerUid}/banner.txt',
        customPayload,
        metadata: SettableMetadata(contentType: 'text/plain'),
      );
      final customRef = storage.refFromURL('gs://flutter-custom-media/public/${h.ownerUid}/banner.txt');
      expect(customRef.bucket, equals('flutter-custom-media'));
      expect(await customRef.getData(1024), equals(customPayload));

      await expectStorageExceptionCode(
        () => storage.ref('public/${h.ownerUid}/banner.txt').getMetadata(),
        'object-not-found',
      );

      final anonCustom = PyricFirebaseStoragePlatform(
        appInstance: h.liveApp,
        bucket: 'gs://flutter-custom-media',
        bridgeClient: h.liveClient,
        authLens: AuthLens.anon,
      );
      expect(await anonCustom.ref('public/${h.ownerUid}/banner.txt').getData(1024), equals(customPayload));
      await expectStorageExceptionCode(
        () => anonCustom.uploadBytes('public/${h.ownerUid}/hack.txt', customPayload),
        'unauthorized',
      );
      await anonCustom.dispose();

      final emulatorStorage = PyricFirebaseStoragePlatform(
        appInstance: h.liveApp,
        bucket: 'gs://flutter-custom-media',
      );
      await emulatorStorage.useStorageEmulator(h.bridgeUri!.host, h.bridgeUri!.port);
      expect(
        await emulatorStorage.ref('public/${h.ownerUid}/banner.txt').getData(1024),
        equals(customPayload),
      );
      await emulatorStorage.dispose();

      final readmeRef = storage.ref('users/${h.ownerUid}/docs/readme.txt');
      final binaryRef = storage.ref('users/${h.ownerUid}/docs/sub/binary.bin');
      await readmeRef.delete();
      await binaryRef.delete();
      await customRef.delete();
      await expectStorageExceptionCode(() => readmeRef.getMetadata(), 'object-not-found');
      await expectStorageExceptionCode(() => readmeRef.getData(1024), 'object-not-found');
      await expectStorageExceptionCode(() => readmeRef.delete(), 'object-not-found');
    });

    test('storage-live#7: streams multi-chunk TaskPlatform uploads, pause/resume/cancel, putString, putFile, and writeToFile', () async {
      if (h.isOffline) {
        final decoded = decodePutStringPayload(
          'data:application/json;base64,eyJvayI6MX0=',
          PutStringFormat.dataUrl,
        );
        expect(decoded.metadata.contentType, equals('application/json'));
        expect(utf8.decode(decoded.bytes), equals('{"ok":1}'));
        return;
      }

      if (!h.isDedicatedStorageHost) {
        final adminStorage = h.newAdminStorage();
        final emptyRef = adminStorage.ref('admin-zero/task.bin');
        final snap = await emptyRef.putData(Uint8List(0)).onComplete;
        expect(snap.state, equals(TaskState.success));
        expect(snap.bytesTransferred, equals(0));
        await emptyRef.delete();
        await adminStorage.dispose();
        return;
      }

      final storage = h.liveStorage!;
      final multiChunk = Uint8List.fromList(
        List<int>.generate(300 * 1024, (int i) => (i * 17 + 5) & 0xff),
      );
      final chunkRef = storage.ref('users/${h.ownerUid}/tasks/multi.bin');
      final uploadTask = chunkRef.putData(
        multiChunk,
        SettableMetadata(
          contentType: 'application/octet-stream',
          customMetadata: const <String, String>{'kind': 'chunked'},
        ),
      );
      final observedStates = <TaskState>[];
      final sub = uploadTask.snapshotEvents.listen((s) => observedStates.add(s.state));
      expect(await uploadTask.pause(), isTrue);
      expect(await uploadTask.resume(), isTrue);
      final done = await uploadTask.onComplete;
      await sub.cancel();
      expect(done.state, equals(TaskState.success));
      expect(done.bytesTransferred, equals(multiChunk.length));
      expect(observedStates, contains(TaskState.paused));

      final dataUrlRef = storage.ref('users/${h.ownerUid}/tasks/config.json');
      final strSnap = await dataUrlRef
          .putString('data:application/json;base64,eyJsaXZlIjp0cnVlfQ==', PutStringFormat.dataUrl)
          .onComplete;
      expect(strSnap.metadata!.contentType, equals('application/json'));
      expect(utf8.decode((await dataUrlRef.getData(128))!), equals('{"live":true}'));

      await withLiveScratchDir('live_', (Directory scratchDir) async {
        final srcFile = File('${scratchDir.path}/src.bin');
        final dstFile = File('${scratchDir.path}/dst.bin');
        await srcFile.writeAsBytes(multiChunk, flush: true);
        final fileRef = storage.ref('users/${h.ownerUid}/tasks/file.bin');
        await fileRef.putFile(srcFile).onComplete;
        final dlSnap = await fileRef.writeToFile(dstFile).onComplete;
        expect(dlSnap.bytesTransferred, equals(multiChunk.length));
        expect(await dstFile.readAsBytes(), equals(multiChunk));
        await fileRef.delete();
      });

      final cancelRef = storage.ref('users/${h.ownerUid}/tasks/canceled.bin');
      final cancelTask = cancelRef.putData(multiChunk);
      expect(await cancelTask.cancel(), isTrue);
      await expectStorageExceptionCode(() => cancelTask.onComplete, 'canceled');
      await expectStorageExceptionCode(() => cancelRef.getMetadata(), 'object-not-found');

      final cleared = await dataUrlRef.updateMetadata(
        SettableMetadata(customMetadata: const <String, String>{}),
      );
      expect(cleared.customMetadata, isNull);
      await chunkRef.delete();
      await dataUrlRef.delete();
    });

    test('storage-live#8: hardens 0-byte transfers, Unicode and slash-normalized paths, and exact maxSize bounds', () async {
      if (h.isOffline) {
        final storage = PyricFirebaseStoragePlatform(bucket: 'demo-flutter-live.appspot.com');
        final normalized = storage.ref('///users//u1///caf\u00e9 100%.txt///');
        expect(normalized.fullPath, equals('users/u1/caf\u00e9 100%.txt'));
        await storage.dispose();
        return;
      }

      if (!h.isDedicatedStorageHost) {
        final adminStorage = h.newAdminStorage();
        final messyRef = adminStorage.ref('///admin-zero//caf\u00e9 \u65e5\u672c\u8a9e//empty.bin///');
        expect(messyRef.fullPath, equals('admin-zero/caf\u00e9 \u65e5\u672c\u8a9e/empty.bin'));
        await messyRef.putData(Uint8List(0)).onComplete;
        expect(await messyRef.getData(0), equals(Uint8List(0)));
        await messyRef.delete();
        await adminStorage.dispose();
        return;
      }

      final storage = h.liveStorage!;
      final zeroRef = storage.ref('///users/${h.ownerUid}//edge//empty.bin///');
      expect(zeroRef.fullPath, equals('users/${h.ownerUid}/edge/empty.bin'));
      final zeroSnap = await zeroRef.putData(Uint8List(0)).onComplete;
      expect(zeroSnap.bytesTransferred, equals(0));
      expect(zeroSnap.totalBytes, equals(0));
      expect(await zeroRef.getData(0), equals(Uint8List(0)));

      await withLiveScratchDir('zero_', (Directory scratchDir) async {
        final zeroDest = File('${scratchDir.path}/overwrite_zero.bin');
        await zeroDest.writeAsBytes(const <int>[9, 8, 7], flush: true);
        await zeroRef.writeToFile(zeroDest).onComplete;
        expect(await zeroDest.readAsBytes(), isEmpty);
      });

      final unicodeRef = storage
          .ref('///users/${h.ownerUid}///')
          .child('//edge//caf\u00e9 \u65e5\u672c\u8a9e 100%.txt///');
      final unicodeBytes = Uint8List.fromList(utf8.encode('unicode-live-\u00e9-\u65e5\u672c\u8a9e'));
      await unicodeRef
          .putData(unicodeBytes, SettableMetadata(contentType: 'text/plain; charset=utf-8'))
          .onComplete;

      await expectStorageExceptionCode(() => unicodeRef.getData(0), 'download-size-exceeded');
      await expectStorageExceptionCode(
        () => unicodeRef.getData(unicodeBytes.length - 1),
        'download-size-exceeded',
      );
      expect(await unicodeRef.getData(unicodeBytes.length), equals(unicodeBytes));

      final unicodeUrl = await unicodeRef.getDownloadURL();
      final viaRefUrl = storage.ref(unicodeUrl);
      expect(viaRefUrl.fullPath, equals(unicodeRef.fullPath));
      final httpFetched = await fetchLiveHttpUrl(Uri.parse(unicodeUrl));
      expect(httpFetched.statusCode, equals(200));
      expect(httpFetched.body, equals(unicodeBytes));

      await zeroRef.delete();
      await unicodeRef.delete();
    });

    test('storage-live#9: executes concurrent multi-chunk transfers across multiple FirebaseApp and bucket delegates', () async {
      if (h.isOffline) {
        final parsed = parseStorageUrlLocation(
          'https://firebasestorage.googleapis.com/v1/b/$liveSecondaryStorageBucket/o/users%2Fu1%2Fblob.bin',
        );
        expect(parsed.bucket, equals(liveSecondaryStorageBucket));
        expect(parsed.path, equals('users/u1/blob.bin'));
        return;
      }

      if (!h.isDedicatedStorageHost) {
        final adminSecondary = PyricFirebaseStoragePlatform(
          appInstance: h.secondaryLiveApp,
          bridgeClient: h.liveClient,
          authLens: AuthLens.admin,
        );
        expect(adminSecondary.resolvedBucket, equals(liveSecondaryStorageBucket));
        expect(adminSecondary.usesNamedBucket, isFalse);
        await Future.wait(<Future<Object?>>[
          adminSecondary.ref('concurrent/a.bin').putData(Uint8List(0)).onComplete,
          adminSecondary.ref('concurrent/b.bin').putData(Uint8List(0)).onComplete,
        ]);
        await adminSecondary.ref('concurrent/a.bin').delete();
        await adminSecondary.ref('concurrent/b.bin').delete();
        await adminSecondary.dispose();
        return;
      }

      final primaryStorage = h.liveStorage!;
      final customStorage = h.liveCustomStorage!;
      final secondaryStorage = h.liveSecondaryStorage!;
      expect(secondaryStorage.resolvedBucket, equals(liveSecondaryStorageBucket));
      expect(secondaryStorage.usesNamedBucket, isFalse);

      final primaryChunked = Uint8List.fromList(
        List<int>.generate(280 * 1024, (int i) => (i * 11 + 3) & 0xff),
      );
      final customChunked = Uint8List.fromList(
        List<int>.generate(272 * 1024, (int i) => (i * 23 + 9) & 0xff),
      );
      final secondaryChunked = Uint8List.fromList(
        List<int>.generate(288 * 1024, (int i) => (i * 29 + 1) & 0xff),
      );

      final primaryRef = primaryStorage.ref('users/${h.ownerUid}/concurrent/shared.bin');
      final customRef = customStorage.ref('public/${h.ownerUid}/concurrent/shared.bin');
      final secondaryRef = secondaryStorage.ref('users/${h.ownerUid}/concurrent/shared.bin');

      await Future.wait(<Future<Object?>>[
        primaryRef.putData(primaryChunked).onComplete,
        customRef.putData(customChunked).onComplete,
        secondaryRef.putData(secondaryChunked).onComplete,
      ]);

      final downloaded = await Future.wait(<Future<Uint8List?>>[
        primaryRef.getData(512 * 1024),
        customRef.getData(512 * 1024),
        secondaryRef.getData(512 * 1024),
      ]);
      expect(downloaded[0], equals(primaryChunked));
      expect(downloaded[1], equals(customChunked));
      expect(downloaded[2], equals(secondaryChunked));

      await expectStorageExceptionCode(
        () => secondaryStorage.ref('users/other-uid/concurrent/shared.bin').putData(Uint8List(4)).onComplete,
        'unauthorized',
      );

      await Future.wait(<Future<void>>[
        primaryRef.delete(),
        customRef.delete(),
        secondaryRef.delete(),
      ]);
    });
  });
}
