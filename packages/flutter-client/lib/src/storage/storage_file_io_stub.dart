import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;

import 'storage_file_io.dart';
import 'storage_upload_sources.dart';

/// Web stub for [FileUploadChunkSource] when `dart:io` is unavailable.
class FileUploadChunkSource implements UploadChunkSource {
  FileUploadChunkSource(Object file);

  @override
  int? get initialKnownLength => null;

  @override
  Future<int> open() async {
    throw FirebaseException(
      plugin: 'firebase_storage',
      code: 'unimplemented',
      message: 'putFile() is not supported on Web without dart:io.',
    );
  }

  @override
  Future<Uint8List> readChunk(int offset, int length) async {
    throw FirebaseException(
      plugin: 'firebase_storage',
      code: 'unimplemented',
      message: 'putFile() is not supported on Web without dart:io.',
    );
  }

  @override
  Future<void> close() async {}
}

bool isPlatformFile(Object? value) => false;

UploadChunkSource createFileUploadChunkSource(Object file) =>
    FileUploadChunkSource(file);

Future<StorageFileWriter> openStorageFileForWrite(Object file) async {
  throw FirebaseException(
    plugin: 'firebase_storage',
    code: 'unimplemented',
    message: 'writeToFile() is not supported on Web without dart:io.',
  );
}
