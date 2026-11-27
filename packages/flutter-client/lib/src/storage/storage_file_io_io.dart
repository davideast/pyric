import 'dart:io';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;

import 'storage_file_io.dart';
import 'storage_upload_sources.dart';

/// Streaming [File] chunk source backed by [RandomAccessFile] with deterministic handle closure.
class FileUploadChunkSource implements UploadChunkSource {
  final File _file;
  RandomAccessFile? _raf;

  FileUploadChunkSource(this._file);

  @override
  int? get initialKnownLength => null;

  @override
  Future<int> open() async {
    try {
      final opened = await _file.open(mode: FileMode.read);
      _raf = opened;
      return await opened.length();
    } on FileSystemException catch (error) {
      await close();
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'unknown',
        message: 'Failed to open upload file "${_file.path}": ${error.message}',
      );
    }
  }

  @override
  Future<Uint8List> readChunk(int offset, int length) async {
    final opened = _raf;
    if (opened == null) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'unknown',
        message: 'Upload file "${_file.path}" is not open.',
      );
    }
    try {
      await opened.setPosition(offset);
      final bytes = await opened.read(length);
      if (bytes.length != length) {
        throw FirebaseException(
          plugin: 'firebase_storage',
          code: 'cannot-slice-blob',
          message:
              'File "${_file.path}" changed size during upload (expected $length bytes at offset $offset, got ${bytes.length}).',
        );
      }
      return bytes;
    } on FileSystemException catch (error) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'unknown',
        message: 'Failed reading upload file "${_file.path}": ${error.message}',
      );
    }
  }

  @override
  Future<void> close() async {
    final opened = _raf;
    _raf = null;
    if (opened != null) {
      try {
        await opened.close();
      } catch (_) {}
    }
  }
}

class _IoStorageFileWriter implements StorageFileWriter {
  final RandomAccessFile _raf;

  _IoStorageFileWriter(this._raf);

  @override
  Future<void> writeFrom(Uint8List bytes) => _raf.writeFrom(bytes);

  @override
  Future<void> flush() => _raf.flush();

  @override
  Future<void> close() => _raf.close();
}

bool isPlatformFile(Object? value) => value is File;

UploadChunkSource createFileUploadChunkSource(Object file) {
  if (file is! File) {
    throw FirebaseException(
      plugin: 'firebase_storage',
      code: 'invalid-argument',
      message: 'Expected a dart:io File instance, got ${file.runtimeType}.',
    );
  }
  return FileUploadChunkSource(file);
}

Future<StorageFileWriter> openStorageFileForWrite(Object file) async {
  if (file is! File) {
    throw FirebaseException(
      plugin: 'firebase_storage',
      code: 'invalid-argument',
      message: 'Expected a dart:io File instance, got ${file.runtimeType}.',
    );
  }
  try {
    if (!await file.parent.exists()) {
      await file.parent.create(recursive: true);
    }
    final raf = await file.open(mode: FileMode.write);
    return _IoStorageFileWriter(raf);
  } on FileSystemException catch (error) {
    throw FirebaseException(
      plugin: 'firebase_storage',
      code: 'unknown',
      message:
          'Failed to open destination file "${file.path}": ${error.message}',
    );
  }
}
