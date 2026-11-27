import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;

import 'storage_file_io.dart';

export 'storage_file_io.dart' show FileUploadChunkSource;

/// Abstract random-access or buffered byte source for chunked Storage uploads.
abstract class UploadChunkSource {
  /// Returns initial known byte count when available synchronously (`null` if deferred until [open]).
  int? get initialKnownLength;

  /// Opens the underlying source and resolves the exact byte length.
  Future<int> open();

  /// Reads [length] bytes starting at [offset].
  Future<Uint8List> readChunk(int offset, int length);

  /// Releases any underlying file descriptor or buffer.
  Future<void> close();
}

/// In-memory [Uint8List] chunk source.
class MemoryUploadChunkSource implements UploadChunkSource {
  final Uint8List _bytes;

  const MemoryUploadChunkSource(this._bytes);

  @override
  int? get initialKnownLength => _bytes.length;

  @override
  Future<int> open() async => _bytes.length;

  @override
  Future<Uint8List> readChunk(int offset, int length) async {
    return Uint8List.sublistView(_bytes, offset, offset + length);
  }

  @override
  Future<void> close() async {}
}

/// [Stream<List<int>>] chunk source for `putBlob` stream inputs.
class StreamUploadChunkSource implements UploadChunkSource {
  final Stream<List<int>> _stream;
  Uint8List? _buffered;

  StreamUploadChunkSource(this._stream);

  @override
  int? get initialKnownLength => null;

  @override
  Future<int> open() async {
    final builder = BytesBuilder(copy: false);
    await for (final chunk in _stream) {
      builder.add(chunk);
    }
    _buffered = builder.takeBytes();
    return _buffered!.length;
  }

  @override
  Future<Uint8List> readChunk(int offset, int length) async {
    final bytes = _buffered ?? Uint8List(0);
    return Uint8List.sublistView(bytes, offset, offset + length);
  }

  @override
  Future<void> close() async {
    _buffered = null;
  }
}

/// Resolves a dynamic `putBlob` input into a typed [UploadChunkSource] or throws `invalid-argument`.
UploadChunkSource resolveBlobUploadSource(Object? data) {
  if (data == null) {
    throw FirebaseException(
      plugin: 'firebase_storage',
      code: 'invalid-argument',
      message: 'putBlob requires non-null data.',
    );
  }
  if (data is Uint8List) {
    return MemoryUploadChunkSource(data);
  }
  if (data is ByteBuffer) {
    return MemoryUploadChunkSource(data.asUint8List());
  }
  if (data is List<int>) {
    return MemoryUploadChunkSource(Uint8List.fromList(data));
  }
  if (data is String) {
    return MemoryUploadChunkSource(Uint8List.fromList(utf8.encode(data)));
  }
  if (isPlatformFile(data)) {
    return createFileUploadChunkSource(data);
  }
  if (data is Stream<List<int>>) {
    return StreamUploadChunkSource(data);
  }
  throw FirebaseException(
    plugin: 'firebase_storage',
    code: 'invalid-argument',
    message:
        'Unsupported putBlob payload type ${data.runtimeType}; expected Uint8List, List<int>, ByteBuffer, String, File, or Stream<List<int>>.',
  );
}
