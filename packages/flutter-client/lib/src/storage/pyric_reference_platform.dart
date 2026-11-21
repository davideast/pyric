import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;
import 'package:firebase_storage_platform_interface/firebase_storage_platform_interface.dart';

import '../transport/exceptions.dart';
import 'pyric_firebase_storage_platform.dart';
import 'pyric_list_result_platform.dart';
import 'pyric_task_platform.dart';
import 'storage_string_codec.dart';
import 'storage_transfer_runner.dart';
import 'storage_upload_sources.dart';
import 'storage_wire_codec.dart';

const int _defaultListMaxResults = 1000;

/// Concrete [ReferencePlatform] backed by [PyricFirebaseStoragePlatform] and the Pyric WebSocket bridge.
class PyricReferencePlatform extends ReferencePlatform {
  final PyricFirebaseStoragePlatform _pyricStorage;
  final String _wirePath;

  PyricReferencePlatform(
    PyricFirebaseStoragePlatform storage,
    String? path,
  )   : _pyricStorage = storage,
        _wirePath = normalizeStorageWirePath(path),
        super(storage, normalizeStoragePointerPath(path));

  /// Bare Pyric wire object path (`""` for bucket root, `"a/b.txt"` for nested objects).
  String get wirePath => _wirePath;

  /// Whether this reference points to the bucket root.
  bool get isRoot => _wirePath.isEmpty;

  @override
  String get bucket => _pyricStorage.resolvedBucket;

  @override
  String get fullPath => _wirePath;

  @override
  String get name {
    if (_wirePath.isEmpty) {
      return '';
    }
    final idx = _wirePath.lastIndexOf('/');
    return idx == -1 ? _wirePath : _wirePath.substring(idx + 1);
  }

  @override
  ReferencePlatform? get parent {
    _pyricStorage.ensureUsable();
    if (_wirePath.isEmpty) {
      return null;
    }
    final idx = _wirePath.lastIndexOf('/');
    final parentPath = idx == -1 ? '' : _wirePath.substring(0, idx);
    return PyricReferencePlatform(_pyricStorage, parentPath);
  }

  @override
  ReferencePlatform get root {
    _pyricStorage.ensureUsable();
    return PyricReferencePlatform(_pyricStorage, '/');
  }

  @override
  ReferencePlatform child(String path) {
    _pyricStorage.ensureUsable();
    validateRelativeStorageChildPath(path);
    final childWirePath = normalizeStorageWirePath(path);
    if (childWirePath.isEmpty) {
      return PyricReferencePlatform(_pyricStorage, _wirePath);
    }
    if (_wirePath.isEmpty) {
      return PyricReferencePlatform(_pyricStorage, childWirePath);
    }
    return PyricReferencePlatform(_pyricStorage, '$_wirePath/$childWirePath');
  }

  @override
  String toString() {
    if (_wirePath.isEmpty) {
      return 'gs://$bucket/';
    }
    return 'gs://$bucket/$_wirePath';
  }

  @override
  Future<Uint8List?> getData(int maxSize) async {
    _pyricStorage.ensureUsable();
    _guardNonRoot('getData');
    if (maxSize < 0) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'invalid-argument',
        message: 'maxSize must be non-negative, got $maxSize.',
      );
    }
    try {
      return await _pyricStorage.byteTransfer.downloadBytes(
        wirePath: _wirePath,
        bucketParams: _pyricStorage.bucketWireParams(),
        maxSize: maxSize,
      );
    } catch (error, stackTrace) {
      throw mapToStorageFirebaseException(error, stackTrace);
    }
  }

  @override
  Future<String> getDownloadURL() async {
    _pyricStorage.ensureUsable();
    _guardNonRoot('getDownloadURL');
    try {
      final raw = await _pyricStorage.dispatchStorageOp(
        'storage.getDownloadURL',
        <String, dynamic>{
          'path': _wirePath,
          ..._pyricStorage.bucketWireParams(),
        },
      );
      if (raw is! Map) {
        throw FirebaseException(
          plugin: 'firebase_storage',
          code: 'unknown',
          message: 'storage.getDownloadURL response was not an object.',
        );
      }
      final urlOrPath = (raw['url'] as String?) ?? (raw['path'] as String?) ?? '';
      if (urlOrPath.isEmpty) {
        throw FirebaseException(
          plugin: 'firebase_storage',
          code: 'unknown',
          message: 'storage.getDownloadURL returned an empty URL.',
        );
      }
      if (urlOrPath.startsWith('http://') ||
          urlOrPath.startsWith('https://') ||
          urlOrPath.startsWith('data:')) {
        return urlOrPath;
      }
      return _pyricStorage.httpBaseOrigin.resolve(urlOrPath).toString();
    } catch (error, stackTrace) {
      throw mapToStorageFirebaseException(error, stackTrace);
    }
  }

  @override
  Future<FullMetadata> getMetadata() async {
    _pyricStorage.ensureUsable();
    _guardNonRoot('getMetadata');
    try {
      final raw = await _pyricStorage.dispatchStorageOp(
        'storage.getMetadata',
        <String, dynamic>{
          'path': _wirePath,
          ..._pyricStorage.bucketWireParams(),
        },
      );
      return decodeWireFullMetadata(
        raw,
        fallbackBucket: bucket,
        fallbackPath: _wirePath,
      );
    } catch (error, stackTrace) {
      throw mapToStorageFirebaseException(error, stackTrace);
    }
  }

  @override
  Future<FullMetadata> updateMetadata(SettableMetadata metadata) async {
    _pyricStorage.ensureUsable();
    _guardNonRoot('updateMetadata');
    final bucketParams = _pyricStorage.bucketWireParams();
    try {
      Map<String, String>? adminExistingCustom;
      if (_pyricStorage.usesAdminLens && metadata.customMetadata != null) {
        final current = await getMetadata();
        adminExistingCustom = current.customMetadata;
      }
      try {
        final directRaw = await _pyricStorage.dispatchStorageOp(
          'storage.setMetadata',
          <String, dynamic>{
            'path': _wirePath,
            ...bucketParams,
            'patch': encodeWireMetadataPatch(
              metadata,
              existingCustomMetadata: adminExistingCustom,
            ),
          },
        );
        return decodeWireFullMetadata(
          directRaw,
          fallbackBucket: bucket,
          fallbackPath: _wirePath,
        );
      } on PyricBridgeException catch (error) {
        final requiresAdminPlaneFallback =
            normalizeStorageErrorCode(error.code) == 'unauthorized' &&
                error.message.contains('admin plane');
        if (!requiresAdminPlaneFallback) {
          rethrow;
        }
      }

      return await _updateMetadataWithRulesCheck(metadata, bucketParams);
    } catch (error, stackTrace) {
      throw mapToStorageFirebaseException(error, stackTrace);
    }
  }

  @override
  Future<void> delete() async {
    _pyricStorage.ensureUsable();
    _guardNonRoot('delete');
    try {
      await _pyricStorage.dispatchStorageOp(
        'storage.deleteObject',
        <String, dynamic>{
          'path': _wirePath,
          ..._pyricStorage.bucketWireParams(),
        },
      );
    } catch (error, stackTrace) {
      throw mapToStorageFirebaseException(error, stackTrace);
    }
  }

  @override
  Future<ListResultPlatform> list([ListOptions? options]) async {
    _pyricStorage.ensureUsable();
    final maxResults = options?.maxResults ?? _defaultListMaxResults;
    if (maxResults <= 0 || maxResults > _defaultListMaxResults) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'invalid-argument',
        message: 'ListOptions.maxResults must be between 1 and 1000, got $maxResults.',
      );
    }
    final offset = options?.pageToken != null
        ? decodeStorageListPageToken(options!.pageToken!)
        : 0;

    try {
      final raw = await _pyricStorage.dispatchStorageOp(
        'storage.listAll',
        <String, dynamic>{
          'path': _wirePath,
          ..._pyricStorage.bucketWireParams(),
        },
      );
      final parsed = _decodeListPayload(raw);
      if (parsed.wireNextPageToken != null) {
        return PyricListResultPlatform(
          _pyricStorage,
          nextPageToken: parsed.wireNextPageToken,
          items: parsed.items,
          prefixes: parsed.prefixes,
        );
      }

      final combined = <_CombinedListEntry>[
        for (final prefix in parsed.prefixes)
          _CombinedListEntry(ref: prefix, isPrefix: true),
        for (final item in parsed.items)
          _CombinedListEntry(ref: item, isPrefix: false),
      ];

      if (offset >= combined.length) {
        return PyricListResultPlatform(
          _pyricStorage,
          nextPageToken: null,
          items: const <ReferencePlatform>[],
          prefixes: const <ReferencePlatform>[],
        );
      }

      final end = offset + maxResults < combined.length
          ? offset + maxResults
          : combined.length;
      final pageSlice = combined.sublist(offset, end);
      final pagePrefixes = <ReferencePlatform>[];
      final pageItems = <ReferencePlatform>[];
      for (final entry in pageSlice) {
        if (entry.isPrefix) {
          pagePrefixes.add(entry.ref);
        } else {
          pageItems.add(entry.ref);
        }
      }
      final nextPageToken =
          end < combined.length ? encodeStorageListPageToken(end) : null;

      return PyricListResultPlatform(
        _pyricStorage,
        nextPageToken: nextPageToken,
        items: pageItems,
        prefixes: pagePrefixes,
      );
    } catch (error, stackTrace) {
      throw mapToStorageFirebaseException(error, stackTrace);
    }
  }

  @override
  Future<ListResultPlatform> listAll() async {
    _pyricStorage.ensureUsable();
    try {
      final raw = await _pyricStorage.dispatchStorageOp(
        'storage.listAll',
        <String, dynamic>{
          'path': _wirePath,
          ..._pyricStorage.bucketWireParams(),
        },
      );
      final parsed = _decodeListPayload(raw);
      return PyricListResultPlatform(
        _pyricStorage,
        nextPageToken: null,
        items: parsed.items,
        prefixes: parsed.prefixes,
      );
    } catch (error, stackTrace) {
      throw mapToStorageFirebaseException(error, stackTrace);
    }
  }

  @override
  TaskPlatform putData(Uint8List data, [SettableMetadata? metadata]) {
    _pyricStorage.ensureUsable();
    _guardNonRoot('putData');
    return _startUploadTask(MemoryUploadChunkSource(data), metadata);
  }

  @override
  TaskPlatform putBlob(dynamic data, [SettableMetadata? metadata]) {
    _pyricStorage.ensureUsable();
    _guardNonRoot('putBlob');
    final source = resolveBlobUploadSource(data);
    return _startUploadTask(source, metadata);
  }

  @override
  TaskPlatform putFile(File file, [SettableMetadata? metadata]) {
    _pyricStorage.ensureUsable();
    _guardNonRoot('putFile');
    return _startUploadTask(FileUploadChunkSource(file), metadata);
  }

  @override
  TaskPlatform putString(
    String data,
    PutStringFormat format, [
    SettableMetadata? metadata,
  ]) {
    _pyricStorage.ensureUsable();
    _guardNonRoot('putString');
    final decoded = decodePutStringPayload(data, format, metadata);
    return _startUploadTask(
      MemoryUploadChunkSource(decoded.bytes),
      decoded.metadata,
    );
  }

  @override
  TaskPlatform writeToFile(File file) {
    _pyricStorage.ensureUsable();
    _guardNonRoot('writeToFile');
    return PyricTaskPlatform(
      ref: this,
      initialTotalBytes: 0,
      onRegister: _pyricStorage.registerActiveTask,
      onUnregister: _pyricStorage.unregisterActiveTask,
      runner: (PyricTaskExecutionContext ctx) {
        return runWriteToFileTask(
          storage: _pyricStorage,
          context: ctx,
          wirePath: _wirePath,
          file: file,
          chunkSize: _pyricStorage.taskChunkSize,
        );
      },
    );
  }

  PyricTaskPlatform _startUploadTask(
    UploadChunkSource source,
    SettableMetadata? metadata,
  ) {
    return PyricTaskPlatform(
      ref: this,
      initialTotalBytes: source.initialKnownLength ?? 0,
      onRegister: _pyricStorage.registerActiveTask,
      onUnregister: _pyricStorage.unregisterActiveTask,
      runner: (PyricTaskExecutionContext ctx) {
        return runResumableUploadTask(
          storage: _pyricStorage,
          context: ctx,
          wirePath: _wirePath,
          source: source,
          metadata: metadata,
          chunkSize: _pyricStorage.taskChunkSize,
        );
      },
    );
  }

  Future<FullMetadata> _updateMetadataWithRulesCheck(
    SettableMetadata metadata,
    Map<String, dynamic> bucketParams,
  ) async {
    const adminActAs = <String, dynamic>{'mode': 'admin'};
    FullMetadata? existing;
    try {
      final existingRaw = await _pyricStorage.dispatchStorageOp(
        'storage.getMetadata',
        <String, dynamic>{
          'path': _wirePath,
          ...bucketParams,
        },
        actAsOverride: adminActAs,
      );
      existing = decodeWireFullMetadata(
        existingRaw,
        fallbackBucket: bucket,
        fallbackPath: _wirePath,
      );
    } on PyricBridgeException catch (error) {
      if (normalizeStorageErrorCode(error.code) != 'object-not-found') {
        rethrow;
      }
    }

    String? mergeHeader(String? updated, String? current) {
      if (updated == null) {
        return current;
      }
      return updated.isEmpty ? null : updated;
    }

    final mergedContentType = mergeHeader(metadata.contentType, existing?.contentType);
    final mergedCustomMetadata =
        metadata.customMetadata ?? existing?.customMetadata;
    final wireSettable = encodeWireSettableMetadata(
      SettableMetadata(
        contentType: mergedContentType,
        cacheControl: mergeHeader(metadata.cacheControl, existing?.cacheControl),
        contentDisposition: mergeHeader(
          metadata.contentDisposition,
          existing?.contentDisposition,
        ),
        contentEncoding: mergeHeader(
          metadata.contentEncoding,
          existing?.contentEncoding,
        ),
        contentLanguage: mergeHeader(
          metadata.contentLanguage,
          existing?.contentLanguage,
        ),
        customMetadata: mergedCustomMetadata,
      ),
    );

    // Evaluate Storage write rules under the caller's actual session/lens via beginUpload,
    // then immediately abort the zero-byte staging handle before applying the metadata patch.
    final beginRaw = await _pyricStorage.dispatchStorageOp(
      'storage.beginUpload',
      <String, dynamic>{
        'path': _wirePath,
        ...bucketParams,
        'size': existing?.size ?? 0,
        if (mergedContentType != null && mergedContentType.isNotEmpty)
          'contentType': mergedContentType,
        if (wireSettable != null) 'metadata': wireSettable,
      },
    );
    if (beginRaw is Map && beginRaw['uploadId'] is String) {
      final uploadId = beginRaw['uploadId'] as String;
      if (uploadId.isNotEmpty) {
        try {
          await _pyricStorage.dispatchStorageOp(
            'storage.abortUpload',
            <String, dynamic>{'uploadId': uploadId},
          );
        } catch (_) {}
      }
    }

    final patchedRaw = await _pyricStorage.dispatchStorageOp(
      'storage.setMetadata',
      <String, dynamic>{
        'path': _wirePath,
        ...bucketParams,
        'patch': encodeWireMetadataPatch(
          metadata,
          existingCustomMetadata: existing?.customMetadata,
        ),
      },
      actAsOverride: adminActAs,
    );
    return decodeWireFullMetadata(
      patchedRaw,
      fallbackBucket: bucket,
      fallbackPath: _wirePath,
    );
  }

  _DecodedListPayload _decodeListPayload(Object? raw) {
    if (raw is! Map) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'unknown',
        message: 'storage.listAll response was not an object.',
      );
    }
    final rawItems = raw['items'];
    final rawPrefixes = raw['prefixes'];
    final items = <ReferencePlatform>[];
    final prefixes = <ReferencePlatform>[];

    if (rawPrefixes is List) {
      for (final entry in rawPrefixes) {
        if (entry is Map && entry['fullPath'] is String) {
          prefixes.add(
            PyricReferencePlatform(_pyricStorage, entry['fullPath'] as String),
          );
        }
      }
    }
    if (rawItems is List) {
      for (final entry in rawItems) {
        if (entry is Map && entry['fullPath'] is String) {
          items.add(
            PyricReferencePlatform(_pyricStorage, entry['fullPath'] as String),
          );
        }
      }
    }
    final wireNextToken = raw['nextPageToken'] as String?;
    return _DecodedListPayload(
      items: items,
      prefixes: prefixes,
      wireNextPageToken:
          (wireNextToken != null && wireNextToken.isNotEmpty) ? wireNextToken : null,
    );
  }

  void _guardNonRoot(String operation) {
    if (isRoot) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'invalid-root-operation',
        message: '$operation cannot operate on the root reference.',
      );
    }
  }
}

class _DecodedListPayload {
  final List<ReferencePlatform> items;
  final List<ReferencePlatform> prefixes;
  final String? wireNextPageToken;

  const _DecodedListPayload({
    required this.items,
    required this.prefixes,
    this.wireNextPageToken,
  });
}

class _CombinedListEntry {
  final ReferencePlatform ref;
  final bool isPrefix;

  const _CombinedListEntry({
    required this.ref,
    required this.isPrefix,
  });
}
