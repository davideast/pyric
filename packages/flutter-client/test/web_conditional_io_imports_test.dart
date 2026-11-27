import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/src/functions/functions_http_transport_stub.dart'
    as fn_stub;
import 'package:pyric_firestore/src/platform/platform_env.dart';
import 'package:pyric_firestore/src/platform/platform_env_stub.dart'
    as env_stub;
import 'package:pyric_firestore/src/storage/storage_file_io_stub.dart'
    as file_stub;
import 'package:pyric_firestore/src/storage/storage_http_client_stub.dart'
    as http_stub;

void main() {
  group('F-02: conditional dart:io imports for Flutter Web compatibility', () {
    test('no non-*_io.dart file under lib/ imports dart:io directly', () {
      final libDir = Directory('lib');
      expect(libDir.existsSync(), isTrue);

      final dartIoImport = RegExp(r'''^\s*(import|export)\s+['"]dart:io['"]''');
      final offenders = <String>[];

      for (final entity in libDir.listSync(recursive: true)) {
        if (entity is! File || !entity.path.endsWith('.dart')) continue;
        if (entity.path.endsWith('_io.dart')) continue;
        final lines = entity.readAsLinesSync();
        for (var i = 0; i < lines.length; i++) {
          if (dartIoImport.hasMatch(lines[i])) {
            offenders.add('${entity.path}:${i + 1}: ${lines[i].trim()}');
          }
        }
      }

      expect(
        offenders,
        isEmpty,
        reason: 'Only *_io.dart conditional targets may import dart:io directly.',
      );
    });

    test('readPlatformEnvironment delegates to Platform.environment on VM', () {
      final pathVar = readPlatformEnvironment('PATH');
      expect(pathVar, Platform.environment['PATH']);
      expect(env_stub.readPlatformEnvironment('PATH'), isNull);
    });

    test('web stubs fail gracefully with structured errors', () async {
      final transport = fn_stub.DartIoFunctionsHttpTransport();
      expect(
        () => transport.postJson(
          uri: Uri.parse('http://localhost/fn'),
          headers: const {},
          body: '{}',
        ),
        throwsUnsupportedError,
      );
      expect(
        () => transport.postSse(
          uri: Uri.parse('http://localhost/fn'),
          headers: const {},
          body: '{}',
        ),
        throwsUnsupportedError,
      );
      transport.close();

      expect(file_stub.isPlatformFile('not-a-file'), isFalse);
      final src = file_stub.createFileUploadChunkSource('fake');
      await expectLater(src.open(), throwsA(anything));
      await expectLater(src.readChunk(0, 1), throwsA(anything));
      await src.close();
      await expectLater(file_stub.openStorageFileForWrite('fake'), throwsA(anything));
      await expectLater(
        http_stub.performStorageHttpRequest(
          method: 'GET',
          uri: Uri.parse('http://localhost/obj'),
          headers: const {},
        ),
        throwsA(anything),
      );
    });
  });
}
