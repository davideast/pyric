import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;
import 'package:firebase_storage_platform_interface/firebase_storage_platform_interface.dart';

import '../transport/exceptions.dart';
import 'pyric_firebase_storage_platform.dart';
import 'storage_wire_codec.dart';

/// Maximum raw byte size of a single part in frame or HTTP byte-route transfers (4 MiB).
const int maxStoragePartBytes = 4 * 1024 * 1024;

/// Maximum raw object size accepted by Pyric Storage (512 MiB).
const int maxStorageObjectBytes = 512 * 1024 * 1024;

bool _indicatesHttpByteRouteHost(PyricBridgeException error) {
  return error.code == 'failed-precondition' &&
      error.message.contains('HTTP byte route');
}

/// Transfers Storage object bytes over either WebSocket base64 frames or the HostedRuntime HTTP byte route.
class StorageByteTransfer {
  final PyricFirebaseStoragePlatform _storage;
  bool _prefersHttpByteRoute = false;

  StorageByteTransfer(this._storage);

  /// Downloads up to [maxSize] bytes for [wirePath], enforcing `download-size-exceeded` when exceeded.
  Future<Uint8List> downloadBytes({
    required String wirePath,
    required Map<String, dynamic> bucketParams,
    required int maxSize,
  }) async {
    if (!_prefersHttpByteRoute) {
      try {
        return await _downloadOverFrames(
          wirePath: wirePath,
          bucketParams: bucketParams,
          maxSize: maxSize,
        );
      } on PyricBridgeException catch (error) {
        if (!_indicatesHttpByteRouteHost(error)) {
          rethrow;
        }
        _prefersHttpByteRoute = true;
      }
    }

    return _downloadOverHttpByteRoute(
      wirePath: wirePath,
      bucketParams: bucketParams,
      maxSize: maxSize,
    );
  }

  /// Uploads [bytes] at [wirePath] and returns the stored [FullMetadata].
  Future<FullMetadata> uploadBytes({
    required String wirePath,
    required Uint8List bytes,
    required Map<String, dynamic> bucketParams,
    SettableMetadata? metadata,
    String? fallbackBucket,
  }) async {
    if (bytes.length > maxStorageObjectBytes) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'quota-exceeded',
        message: 'Object "$wirePath" (${bytes.length} bytes) exceeds 512 MiB cap.',
      );
    }

    final wireMeta = encodeWireSettableMetadata(metadata);
    final contentType = metadata?.contentType;

    if (!_prefersHttpByteRoute) {
      try {
        return await _uploadOverFrames(
          wirePath: wirePath,
          bytes: bytes,
          bucketParams: bucketParams,
          contentType: contentType,
          wireMetadata: wireMeta,
          fallbackBucket: fallbackBucket,
        );
      } on PyricBridgeException catch (error) {
        if (!_indicatesHttpByteRouteHost(error)) {
          rethrow;
        }
        _prefersHttpByteRoute = true;
      }
    }

    return _uploadOverHttpByteRoute(
      wirePath: wirePath,
      bytes: bytes,
      bucketParams: bucketParams,
      contentType: contentType,
      wireMetadata: wireMeta,
      fallbackBucket: fallbackBucket,
    );
  }

  Future<Uint8List> _downloadOverFrames({
    required String wirePath,
    required Map<String, dynamic> bucketParams,
    required int maxSize,
  }) async {
    try {
      final raw = await _storage.dispatchStorageOp(
        'storage.getBytes',
        <String, dynamic>{
          'path': wirePath,
          ...bucketParams,
        },
      );
      final map = _requireMap(raw, 'storage.getBytes');
      final declaredSize = (map['size'] as num?)?.toInt();
      if (declaredSize != null && declaredSize > maxSize) {
        throw _downloadSizeExceeded(wirePath, declaredSize, maxSize);
      }
      final dataB64 = map['dataB64'] as String? ?? '';
      final decoded = Uint8List.fromList(base64Decode(dataB64));
      if (decoded.length > maxSize) {
        throw _downloadSizeExceeded(wirePath, decoded.length, maxSize);
      }
      return decoded;
    } on PyricBridgeException catch (error) {
      if (error.code != 'payload-too-large') {
        rethrow;
      }
    }

    final metaRaw = await _storage.dispatchStorageOp(
      'storage.getMetadata',
      <String, dynamic>{
        'path': wirePath,
        ...bucketParams,
      },
    );
    final meta = decodeWireFullMetadata(metaRaw, fallbackPath: wirePath);
    final totalSize = meta.size ?? 0;
    if (totalSize > maxSize) {
      throw _downloadSizeExceeded(wirePath, totalSize, maxSize);
    }
    final builder = BytesBuilder(copy: false);
    var offset = 0;
    while (offset < totalSize) {
      final remaining = totalSize - offset;
      final chunkLen =
          remaining < maxStoragePartBytes ? remaining : maxStoragePartBytes;
      final chunkRaw = await _storage.dispatchStorageOp(
        'storage.getBytes',
        <String, dynamic>{
          'path': wirePath,
          ...bucketParams,
          'offset': offset,
          'length': chunkLen,
          if (meta.generation != null) 'expectedGeneration': meta.generation,
        },
      );
      final chunkMap = _requireMap(chunkRaw, 'storage.getBytes');
      final chunkBytes = base64Decode(chunkMap['dataB64'] as String? ?? '');
      builder.add(chunkBytes);
      offset += chunkLen;
    }
    final assembled = builder.takeBytes();
    if (assembled.length > maxSize) {
      throw _downloadSizeExceeded(wirePath, assembled.length, maxSize);
    }
    return assembled;
  }

  Future<Uint8List> _downloadOverHttpByteRoute({
    required String wirePath,
    required Map<String, dynamic> bucketParams,
    required int maxSize,
  }) async {
    for (var attempt = 0; attempt < 2; attempt += 1) {
      final metaRaw = await _storage.dispatchStorageOp(
        'storage.getMetadata',
        <String, dynamic>{
          'path': wirePath,
          ...bucketParams,
        },
      );
      final metaMap = _requireMap(metaRaw, 'storage.getMetadata');
      final size = (metaMap['size'] as num?)?.toInt() ?? 0;
      if (size > maxSize) {
        throw _downloadSizeExceeded(wirePath, size, maxSize);
      }
      if (size == 0) {
        return Uint8List(0);
      }
      final bucket = (metaMap['bucket'] as String?)?.isNotEmpty == true
          ? metaMap['bucket'] as String
          : (_storage.resolvedBucket.isNotEmpty
              ? _storage.resolvedBucket
              : 'pyric-default');
      final generation = metaMap['generation']?.toString();
      final encodedBucket = Uri.encodeComponent(bucket);
      final encodedPath = Uri.encodeComponent(wirePath);
      final queryParams = <String, String>{
        'alt': 'media',
        if (generation != null && generation.isNotEmpty)
          'generation': generation,
      };
      final objectUri = _storage.httpBaseOrigin.replace(
        path: '/__pyric/storage/v0/b/$encodedBucket/o/$encodedPath',
        queryParameters: queryParams,
      );

      final response = await _performHttpRequest(
        method: 'GET',
        uri: objectUri,
        headers: _storage.byteRouteReadHeaders(),
      );
      if (response.statusCode == 412) {
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw mapHttpStatusToStorageException(
          response.statusCode,
          wirePath,
          utf8.decode(response.body, allowMalformed: true),
        );
      }
      if (response.body.length > maxSize) {
        throw _downloadSizeExceeded(wirePath, response.body.length, maxSize);
      }
      return response.body;
    }

    throw FirebaseException(
      plugin: 'firebase_storage',
      code: 'retry-limit-exceeded',
      message: 'Object "$wirePath" changed repeatedly during download.',
    );
  }

  Future<FullMetadata> _uploadOverFrames({
    required String wirePath,
    required Uint8List bytes,
    required Map<String, dynamic> bucketParams,
    String? contentType,
    Map<String, dynamic>? wireMetadata,
    String? fallbackBucket,
  }) async {
    if (bytes.length <= maxStoragePartBytes) {
      final raw = await _storage.dispatchStorageOp(
        'storage.putBytes',
        <String, dynamic>{
          'path': wirePath,
          ...bucketParams,
          'dataB64': base64Encode(bytes),
          if (contentType != null && contentType.isNotEmpty)
            'contentType': contentType,
          if (wireMetadata != null) 'metadata': wireMetadata,
        },
      );
      return decodeWireFullMetadata(
        raw,
        fallbackBucket: fallbackBucket,
        fallbackPath: wirePath,
      );
    }

    final beginRaw = await _storage.dispatchStorageOp(
      'storage.beginUpload',
      <String, dynamic>{
        'path': wirePath,
        ...bucketParams,
        'size': bytes.length,
        if (contentType != null && contentType.isNotEmpty)
          'contentType': contentType,
        if (wireMetadata != null) 'metadata': wireMetadata,
      },
    );
    final beginMap = _requireMap(beginRaw, 'storage.beginUpload');
    final uploadId = beginMap['uploadId'] as String? ?? '';
    if (uploadId.isEmpty) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'unknown',
        message: 'storage.beginUpload did not return an uploadId.',
      );
    }

    try {
      var offset = 0;
      var partIndex = 0;
      while (offset < bytes.length) {
        final end = offset + maxStoragePartBytes < bytes.length
            ? offset + maxStoragePartBytes
            : bytes.length;
        final slice = Uint8List.sublistView(bytes, offset, end);
        await _storage.dispatchStorageOp(
          'storage.putPart',
          <String, dynamic>{
            'uploadId': uploadId,
            'partIndex': partIndex,
            'dataB64': base64Encode(slice),
          },
        );
        offset = end;
        partIndex += 1;
      }
      final finishRaw = await _storage.dispatchStorageOp(
        'storage.finishUpload',
        <String, dynamic>{'uploadId': uploadId},
      );
      return decodeWireFullMetadata(
        finishRaw,
        fallbackBucket: fallbackBucket,
        fallbackPath: wirePath,
      );
    } catch (_) {
      await _bestEffortAbortUpload(uploadId);
      rethrow;
    }
  }

  Future<FullMetadata> _uploadOverHttpByteRoute({
    required String wirePath,
    required Uint8List bytes,
    required Map<String, dynamic> bucketParams,
    String? contentType,
    Map<String, dynamic>? wireMetadata,
    String? fallbackBucket,
  }) async {
    final beginRaw = await _storage.dispatchStorageOp(
      'storage.beginUpload',
      <String, dynamic>{
        'path': wirePath,
        ...bucketParams,
        'size': bytes.length,
        if (contentType != null && contentType.isNotEmpty)
          'contentType': contentType,
        if (wireMetadata != null) 'metadata': wireMetadata,
      },
    );
    final beginMap = _requireMap(beginRaw, 'storage.beginUpload');
    final uploadId = beginMap['uploadId'] as String? ?? '';
    final uploadUrlPath = beginMap['uploadUrl'] as String? ?? '';
    if (uploadId.isEmpty || uploadUrlPath.isEmpty) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'unknown',
        message: 'storage.beginUpload did not return an uploadId and uploadUrl.',
      );
    }

    final uploadUri = _storage.httpBaseOrigin.resolve(uploadUrlPath);
    try {
      if (bytes.isNotEmpty) {
        var offset = 0;
        while (offset < bytes.length) {
          final end = offset + maxStoragePartBytes < bytes.length
              ? offset + maxStoragePartBytes
              : bytes.length;
          final slice = Uint8List.sublistView(bytes, offset, end);
          final sliceRes = await _performHttpRequest(
            method: 'PUT',
            uri: uploadUri,
            headers: <String, String>{
              'content-range': 'bytes $offset-${end - 1}/${bytes.length}',
              'content-length': '${slice.length}',
            },
            body: slice,
          );
          final accepted = sliceRes.statusCode == 200 ||
              sliceRes.statusCode == 308;
          if (!accepted) {
            throw mapHttpStatusToStorageException(
              sliceRes.statusCode,
              wirePath,
              utf8.decode(sliceRes.body, allowMalformed: true),
            );
          }
          offset = end;
        }
      }

      final finishRaw = await _storage.dispatchStorageOp(
        'storage.finishUpload',
        <String, dynamic>{'uploadId': uploadId},
      );
      return decodeWireFullMetadata(
        finishRaw,
        fallbackBucket: fallbackBucket,
        fallbackPath: wirePath,
      );
    } catch (_) {
      await _bestEffortAbortUpload(uploadId);
      rethrow;
    }
  }

  Future<void> _bestEffortAbortUpload(String uploadId) async {
    try {
      await _storage.dispatchStorageOp(
        'storage.abortUpload',
        <String, dynamic>{'uploadId': uploadId},
      );
    } catch (_) {
      // Ignore secondary cleanup failures while propagating primary failure.
    }
  }

  Map<String, dynamic> _requireMap(Object? raw, String opName) {
    if (raw is Map) {
      return Map<String, dynamic>.from(raw);
    }
    throw FirebaseException(
      plugin: 'firebase_storage',
      code: 'unknown',
      message: 'Expected object response from $opName.',
    );
  }

  FirebaseException _downloadSizeExceeded(
    String wirePath,
    int actualBytes,
    int maxSize,
  ) {
    return FirebaseException(
      plugin: 'firebase_storage',
      code: 'download-size-exceeded',
      message:
          'Object "$wirePath" size ($actualBytes bytes) exceeds maxSize ($maxSize bytes).',
    );
  }

  Future<_RawHttpResponse> _performHttpRequest({
    required String method,
    required Uri uri,
    required Map<String, String> headers,
    Uint8List? body,
  }) async {
    final client = HttpClient();
    try {
      final request = await client.openUrl(method, uri);
      headers.forEach(request.headers.set);
      if (body != null) {
        request.contentLength = body.length;
        request.add(body);
      }
      final response = await request.close();
      final bytesBuilder = BytesBuilder(copy: false);
      await for (final chunk in response) {
        bytesBuilder.add(chunk);
      }
      return _RawHttpResponse(
        statusCode: response.statusCode,
        body: bytesBuilder.takeBytes(),
      );
    } finally {
      client.close(force: false);
    }
  }
}

class _RawHttpResponse {
  final int statusCode;
  final Uint8List body;

  const _RawHttpResponse({
    required this.statusCode,
    required this.body,
  });
}
