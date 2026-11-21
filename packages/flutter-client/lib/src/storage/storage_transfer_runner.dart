import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;
import 'package:firebase_storage_platform_interface/firebase_storage_platform_interface.dart';

import '../transport/exceptions.dart';
import 'pyric_firebase_storage_platform.dart';
import 'pyric_task_platform.dart';
import 'storage_byte_transfer.dart';
import 'storage_upload_sources.dart';
import 'storage_wire_codec.dart';

/// Default chunk granularity (256 KiB) for resumable Storage uploads and file downloads.
const int defaultStorageTaskChunkBytes = 256 * 1024;

bool _isHttpByteRoutePrecondition(PyricBridgeException error) {
  return error.code == 'failed-precondition' &&
      error.message.contains('HTTP byte route');
}

/// Executes a chunked resumable upload over `storage.beginUpload`, `storage.putPart` / HTTP `PUT`,
/// `storage.finishUpload`, `storage.abortUpload`, and `storage.rollbackUpload`.
Future<CompletedTaskPayload> runResumableUploadTask({
  required PyricFirebaseStoragePlatform storage,
  required PyricTaskExecutionContext context,
  required String wirePath,
  required UploadChunkSource source,
  SettableMetadata? metadata,
  int chunkSize = defaultStorageTaskChunkBytes,
}) async {
  final effectiveChunkSize =
      (chunkSize > 0 && chunkSize <= maxStoragePartBytes)
          ? chunkSize
          : defaultStorageTaskChunkBytes;
  final bucketParams = storage.bucketWireParams();
  final fallbackBucket = storage.resolvedBucket;
  final wireMeta = encodeWireSettableMetadata(metadata);
  final contentType = metadata?.contentType;

  String? activeUploadId;
  HttpClient? activeHttpClient;
  Future<dynamic>? inFlightFinishOp;
  String? committedRollbackToken;

  context.setCancelCleanup(() async {
    final http = activeHttpClient;
    activeHttpClient = null;
    http?.close(force: true);

    final pendingFinish = inFlightFinishOp;
    if (pendingFinish != null) {
      try {
        final settled = await pendingFinish;
        if (settled is Map && settled['rollbackToken'] is String) {
          committedRollbackToken = settled['rollbackToken'] as String;
        }
      } catch (_) {}
    }

    final token = committedRollbackToken;
    if (token != null && token.isNotEmpty) {
      await storage.dispatchStorageOp(
        'storage.rollbackUpload',
        <String, dynamic>{'rollbackToken': token},
      );
      return;
    }

    final uploadIdToAbort = activeUploadId;
    activeUploadId = null;
    if (uploadIdToAbort != null && uploadIdToAbort.isNotEmpty) {
      await storage.dispatchStorageOp(
        'storage.abortUpload',
        <String, dynamic>{'uploadId': uploadIdToAbort},
      );
    }
  });

  try {
    final totalBytes = await source.open();
    if (totalBytes > maxStorageObjectBytes) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'quota-exceeded',
        message: 'Object "$wirePath" ($totalBytes bytes) exceeds 512 MiB cap.',
      );
    }
    context.updateTotalBytes(totalBytes);
    await context.waitUntilRunningOrThrowCanceled();

    final beginRaw = await storage.dispatchStorageOp(
      'storage.beginUpload',
      <String, dynamic>{
        'path': wirePath,
        ...bucketParams,
        'size': totalBytes,
        if (contentType != null && contentType.isNotEmpty)
          'contentType': contentType,
        if (wireMeta != null && wireMeta.isNotEmpty) 'metadata': wireMeta,
      },
    );
    if (beginRaw is! Map) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'unknown',
        message: 'Expected object response from storage.beginUpload.',
      );
    }
    final uploadId = beginRaw['uploadId'] as String? ?? '';
    final uploadUrlPath = beginRaw['uploadUrl'] as String? ?? '';
    if (uploadId.isEmpty) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'unknown',
        message: 'storage.beginUpload did not return an uploadId.',
      );
    }
    activeUploadId = uploadId;
    await context.waitUntilRunningOrThrowCanceled();

    try {
      if (totalBytes > 0) {
        var offset = 0;
        var partIndex = 0;
        while (offset < totalBytes) {
          await context.waitUntilRunningOrThrowCanceled();
          final remaining = totalBytes - offset;
          final sliceLen =
              remaining < effectiveChunkSize ? remaining : effectiveChunkSize;
          final chunkBytes = await source.readChunk(offset, sliceLen);
          await context.waitUntilRunningOrThrowCanceled();

          var sentChunk = false;
          if (!storage.byteTransfer.prefersHttpByteRoute) {
            try {
              await storage.dispatchStorageOp(
                'storage.putPart',
                <String, dynamic>{
                  'uploadId': uploadId,
                  'partIndex': partIndex,
                  'dataB64': base64Encode(chunkBytes),
                },
              );
              sentChunk = true;
            } on PyricBridgeException catch (error) {
              if (!_isHttpByteRoutePrecondition(error)) {
                rethrow;
              }
              storage.byteTransfer.markHttpByteRoutePreferred();
            }
          }

          if (!sentChunk) {
            if (uploadUrlPath.isEmpty) {
              throw FirebaseException(
                plugin: 'firebase_storage',
                code: 'unknown',
                message:
                    'Host requires HTTP byte route, but storage.beginUpload returned no uploadUrl.',
              );
            }
            final uploadUri = storage.httpBaseOrigin.resolve(uploadUrlPath);
            final endInclusive = offset + chunkBytes.length - 1;
            await _sendHttpSlice(
              uri: uploadUri,
              wirePath: wirePath,
              headers: <String, String>{
                'content-range': 'bytes $offset-$endInclusive/$totalBytes',
                'content-length': '${chunkBytes.length}',
              },
              body: chunkBytes,
              onClientCreated: (client) => activeHttpClient = client,
              onClientClosed: () => activeHttpClient = null,
            );
          }

          offset += chunkBytes.length;
          partIndex += 1;
          context.reportProgress(offset, totalBytes: totalBytes);
        }
      } else if (storage.byteTransfer.prefersHttpByteRoute &&
          uploadUrlPath.isNotEmpty) {
        final uploadUri = storage.httpBaseOrigin.resolve(uploadUrlPath);
        await _sendHttpSlice(
          uri: uploadUri,
          wirePath: wirePath,
          headers: const <String, String>{'content-length': '0'},
          body: Uint8List(0),
          onClientCreated: (client) => activeHttpClient = client,
          onClientClosed: () => activeHttpClient = null,
        );
      }

      await context.waitUntilRunningOrThrowCanceled();

      final finishFuture = storage.dispatchStorageOp(
        'storage.finishUpload',
        <String, dynamic>{
          'uploadId': uploadId,
          'rollback': true,
        },
      );
      inFlightFinishOp = finishFuture;
      final finishRaw = await finishFuture;
      inFlightFinishOp = null;
      activeUploadId = null;

      if (finishRaw is Map && finishRaw['rollbackToken'] is String) {
        committedRollbackToken = finishRaw['rollbackToken'] as String;
      }

      await context.waitUntilRunningOrThrowCanceled();

      final metadataMap = decodeWireFullMetadataMap(
        finishRaw,
        fallbackBucket: fallbackBucket,
        fallbackPath: wirePath,
      );
      final decodedMeta = PyricFullMetadata(metadataMap);
      return CompletedTaskPayload(
        bytesTransferred: totalBytes,
        totalBytes: totalBytes,
        metadata: decodedMeta,
        metadataMap: metadataMap,
      );
    } catch (_) {
      if (!context.isCanceled && activeUploadId != null) {
        final idToAbort = activeUploadId!;
        activeUploadId = null;
        try {
          await storage.dispatchStorageOp(
            'storage.abortUpload',
            <String, dynamic>{'uploadId': idToAbort},
          );
        } catch (_) {}
      }
      rethrow;
    }
  } finally {
    await source.close();
  }
}

/// Streams a remote Storage object into [file], overwriting any existing file and emitting progress.
Future<CompletedTaskPayload> runWriteToFileTask({
  required PyricFirebaseStoragePlatform storage,
  required PyricTaskExecutionContext context,
  required String wirePath,
  required File file,
  int chunkSize = defaultStorageTaskChunkBytes,
}) async {
  final effectiveChunkSize =
      (chunkSize > 0 && chunkSize <= maxStoragePartBytes)
          ? chunkSize
          : defaultStorageTaskChunkBytes;
  final bucketParams = storage.bucketWireParams();
  final fallbackBucket = storage.resolvedBucket;

  HttpClient? activeHttpClient;
  context.setCancelCleanup(() async {
    final http = activeHttpClient;
    activeHttpClient = null;
    http?.close(force: true);
  });

  await context.waitUntilRunningOrThrowCanceled();
  final metaRaw = await storage.dispatchStorageOp(
    'storage.getMetadata',
    <String, dynamic>{
      'path': wirePath,
      ...bucketParams,
    },
  );
  final metadataMap = decodeWireFullMetadataMap(
    metaRaw,
    fallbackBucket: fallbackBucket,
    fallbackPath: wirePath,
  );
  final meta = PyricFullMetadata(metadataMap);
  final totalBytes = meta.size ?? 0;
  final generation = meta.generation;
  final effectiveBucket = (meta.bucket != null && meta.bucket!.isNotEmpty)
      ? meta.bucket!
      : (fallbackBucket.isNotEmpty ? fallbackBucket : 'pyric-default');

  context.updateTotalBytes(totalBytes);
  context.reportProgress(0, totalBytes: totalBytes);
  await context.waitUntilRunningOrThrowCanceled();

  RandomAccessFile? raf;
  try {
    try {
      if (!await file.parent.exists()) {
        await file.parent.create(recursive: true);
      }
      raf = await file.open(mode: FileMode.write);
    } on FileSystemException catch (error) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'unknown',
        message:
            'Failed to open destination file "${file.path}": ${error.message}',
      );
    }

    var offset = 0;
    while (offset < totalBytes) {
      await context.waitUntilRunningOrThrowCanceled();
      final remaining = totalBytes - offset;
      final wantLen =
          remaining < effectiveChunkSize ? remaining : effectiveChunkSize;

      Uint8List? sliceBytes;
      if (!storage.byteTransfer.prefersHttpByteRoute) {
        try {
          final getRaw = await storage.dispatchStorageOp(
            'storage.getBytes',
            <String, dynamic>{
              'path': wirePath,
              ...bucketParams,
              'offset': offset,
              'length': wantLen,
              if (generation != null && generation.isNotEmpty)
                'expectedGeneration': generation,
            },
          );
          if (getRaw is! Map) {
            throw FirebaseException(
              plugin: 'firebase_storage',
              code: 'unknown',
              message: 'Expected object response from storage.getBytes.',
            );
          }
          final decoded = Uint8List.fromList(
            base64Decode(getRaw['dataB64'] as String? ?? ''),
          );
          if (decoded.length > wantLen && offset + wantLen <= decoded.length) {
            sliceBytes =
                Uint8List.sublistView(decoded, offset, offset + wantLen);
          } else {
            sliceBytes = decoded;
          }
        } on PyricBridgeException catch (error) {
          if (!_isHttpByteRoutePrecondition(error)) {
            rethrow;
          }
          storage.byteTransfer.markHttpByteRoutePreferred();
        }
      }

      if (sliceBytes == null) {
        final encodedBucket = Uri.encodeComponent(effectiveBucket);
        final encodedPath = Uri.encodeComponent(wirePath);
        final objectUri = storage.httpBaseOrigin.replace(
          path: '/__pyric/storage/v0/b/$encodedBucket/o/$encodedPath',
          queryParameters: <String, String>{
            'alt': 'media',
            if (generation != null && generation.isNotEmpty)
              'generation': generation,
          },
        );
        final headers = <String, String>{
          ...storage.byteRouteReadHeaders(),
          'range': 'bytes=$offset-${offset + wantLen - 1}',
        };
        final fetched = await _fetchHttpSlice(
          uri: objectUri,
          wirePath: wirePath,
          headers: headers,
          onClientCreated: (client) => activeHttpClient = client,
          onClientClosed: () => activeHttpClient = null,
        );
        if (fetched.statusCode == 200 &&
            fetched.body.length > wantLen &&
            offset + wantLen <= fetched.body.length) {
          sliceBytes = Uint8List.sublistView(
            fetched.body,
            offset,
            offset + wantLen,
          );
        } else {
          sliceBytes = fetched.body;
        }
      }

      if (sliceBytes.isEmpty) {
        throw FirebaseException(
          plugin: 'firebase_storage',
          code: 'server-file-wrong-size',
          message:
              'Unexpected EOF while downloading "$wirePath" at offset $offset/$totalBytes.',
        );
      }

      await context.waitUntilRunningOrThrowCanceled();
      await raf.writeFrom(sliceBytes);
      offset += sliceBytes.length;
      context.reportProgress(offset, totalBytes: totalBytes);
    }

    await raf.flush();
  } finally {
    if (raf != null) {
      try {
        await raf.close();
      } catch (_) {}
    }
  }

  return CompletedTaskPayload(
    bytesTransferred: totalBytes,
    totalBytes: totalBytes,
    metadata: meta,
    metadataMap: metadataMap,
  );
}

Future<void> _sendHttpSlice({
  required Uri uri,
  required String wirePath,
  required Map<String, String> headers,
  required Uint8List body,
  required void Function(HttpClient client) onClientCreated,
  required void Function() onClientClosed,
}) async {
  final client = HttpClient();
  onClientCreated(client);
  try {
    final request = await client.openUrl('PUT', uri);
    headers.forEach(request.headers.set);
    request.contentLength = body.length;
    if (body.isNotEmpty) {
      request.add(body);
    }
    final response = await request.close();
    final respBody = BytesBuilder(copy: false);
    await for (final chunk in response) {
      respBody.add(chunk);
    }
    final accepted = response.statusCode == 200 || response.statusCode == 308;
    if (!accepted) {
      throw mapHttpStatusToStorageException(
        response.statusCode,
        wirePath,
        utf8.decode(respBody.takeBytes(), allowMalformed: true),
      );
    }
  } finally {
    onClientClosed();
    client.close(force: false);
  }
}

class _HttpSliceResult {
  final int statusCode;
  final Uint8List body;

  const _HttpSliceResult({
    required this.statusCode,
    required this.body,
  });
}

Future<_HttpSliceResult> _fetchHttpSlice({
  required Uri uri,
  required String wirePath,
  required Map<String, String> headers,
  required void Function(HttpClient client) onClientCreated,
  required void Function() onClientClosed,
}) async {
  final client = HttpClient();
  onClientCreated(client);
  try {
    final request = await client.openUrl('GET', uri);
    headers.forEach(request.headers.set);
    final response = await request.close();
    final respBody = BytesBuilder(copy: false);
    await for (final chunk in response) {
      respBody.add(chunk);
    }
    final bodyBytes = respBody.takeBytes();
    final accepted = response.statusCode == 200 || response.statusCode == 206;
    if (!accepted) {
      throw mapHttpStatusToStorageException(
        response.statusCode,
        wirePath,
        utf8.decode(bodyBytes, allowMalformed: true),
      );
    }
    return _HttpSliceResult(
      statusCode: response.statusCode,
      body: bodyBytes,
    );
  } finally {
    onClientClosed();
    client.close(force: false);
  }
}
