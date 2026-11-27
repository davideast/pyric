import 'dart:typed_data';

import 'storage_file_io_stub.dart'
    if (dart.library.io) 'storage_file_io_io.dart' as impl;
import 'storage_upload_sources.dart';

export 'storage_file_io_stub.dart'
    if (dart.library.io) 'storage_file_io_io.dart'
    show FileUploadChunkSource;

/// Sequential file writer abstraction used by `runWriteToFileTask`.
abstract interface class StorageFileWriter {
  Future<void> writeFrom(Uint8List bytes);
  Future<void> flush();
  Future<void> close();
}

/// Returns `true` when [value] is a platform `dart:io` `File` instance.
bool isPlatformFile(Object? value) => impl.isPlatformFile(value);

/// Wraps a platform `dart:io` `File` as an [UploadChunkSource].
UploadChunkSource createFileUploadChunkSource(Object file) =>
    impl.createFileUploadChunkSource(file);

/// Opens [file] for writing (creating parent directories if needed).
Future<StorageFileWriter> openStorageFileForWrite(Object file) =>
    impl.openStorageFileForWrite(file);
