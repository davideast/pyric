import 'dart:convert';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;
import 'package:firebase_storage_platform_interface/firebase_storage_platform_interface.dart';

import '../transport/exceptions.dart';

/// Concrete [FullMetadata] wrapper exposing the protected superclass constructor cleanly.
class PyricFullMetadata extends FullMetadata {
  PyricFullMetadata(super.metadata);
}

/// Parsed bucket and object path extracted from a `gs://` or `http(s)://` Storage URL.
class ParsedStorageUrl {
  final String bucket;
  final String path;

  const ParsedStorageUrl({
    required this.bucket,
    required this.path,
  });
}

/// Normalizes Pyric bridge and HTTP Storage error codes to FlutterFire `firebase_storage` codes.
String normalizeStorageErrorCode(String rawCode) {
  final trimmed = rawCode.trim();
  if (trimmed.isEmpty) {
    return 'unknown';
  }

  var stripped = trimmed;
  final slashIndex = trimmed.indexOf('/');
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    final prefix = trimmed.substring(0, slashIndex).toLowerCase();
    if (prefix == 'storage' || prefix == 'firebase_storage') {
      stripped = trimmed.substring(slashIndex + 1);
    }
  }

  final lower = stripped.toLowerCase();
  switch (lower) {
    case 'object-not-found':
    case 'not-found':
      return 'object-not-found';
    case 'bucket-not-found':
      return 'bucket-not-found';
    case 'project-not-found':
      return 'project-not-found';
    case 'quota-exceeded':
    case 'payload-too-large':
    case 'resource-exhausted':
      return 'quota-exceeded';
    case 'unauthenticated':
      return 'unauthenticated';
    case 'unauthorized':
    case 'permission-denied':
    case 'permission_denied':
      return 'unauthorized';
    case 'retry-limit-exceeded':
    case 'deadline-exceeded':
      return 'retry-limit-exceeded';
    case 'invalid-checksum':
      return 'invalid-checksum';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    case 'invalid-event-name':
      return 'invalid-event-name';
    case 'invalid-url':
      return 'invalid-url';
    case 'invalid-argument':
      return 'invalid-argument';
    case 'no-default-bucket':
      return 'no-default-bucket';
    case 'cannot-slice-blob':
      return 'cannot-slice-blob';
    case 'server-file-wrong-size':
      return 'server-file-wrong-size';
    case 'download-size-exceeded':
      return 'download-size-exceeded';
    case 'invalid-root-operation':
      return 'invalid-root-operation';
    case 'object-changed':
      return 'retry-limit-exceeded';
    case 'unknown':
      return 'unknown';
    default:
      return lower;
  }
}

/// Maps HTTP status codes from the Pyric Storage byte route into `firebase_storage` codes.
FirebaseException mapHttpStatusToStorageException(
  int statusCode,
  String path, [
  String? detail,
]) {
  final suffix = (detail != null && detail.trim().isNotEmpty)
      ? ': ${detail.trim()}'
      : '';
  if (statusCode == 401) {
    return FirebaseException(
      plugin: 'firebase_storage',
      code: 'unauthenticated',
      message: 'Unauthenticated Storage byte-route request for "$path"$suffix',
    );
  }
  if (statusCode == 403) {
    return FirebaseException(
      plugin: 'firebase_storage',
      code: 'unauthorized',
      message: 'User is not authorized to perform the desired action on "$path"$suffix',
    );
  }
  if (statusCode == 404) {
    return FirebaseException(
      plugin: 'firebase_storage',
      code: 'object-not-found',
      message: 'No object exists at the desired reference "$path"$suffix',
    );
  }
  if (statusCode == 413) {
    return FirebaseException(
      plugin: 'firebase_storage',
      code: 'quota-exceeded',
      message: 'Payload exceeded Storage size limit for "$path"$suffix',
    );
  }
  return FirebaseException(
    plugin: 'firebase_storage',
    code: 'unknown',
    message: 'Storage HTTP byte route returned status $statusCode for "$path"$suffix',
  );
}

/// Wraps bridge or decoding failures into a canonical `firebase_storage` [FirebaseException].
FirebaseException mapToStorageFirebaseException(
  Object error, [
  StackTrace? stackTrace,
]) {
  if (error is FirebaseException) {
    if (error.plugin == 'firebase_storage') {
      return error;
    }
    return FirebaseException(
      plugin: 'firebase_storage',
      code: normalizeStorageErrorCode(error.code),
      message: error.message,
      stackTrace: stackTrace ?? error.stackTrace,
    );
  }
  if (error is PyricBridgeException) {
    return FirebaseException(
      plugin: 'firebase_storage',
      code: normalizeStorageErrorCode(error.code),
      message: error.message,
      stackTrace: stackTrace,
    );
  }
  return FirebaseException(
    plugin: 'firebase_storage',
    code: 'unknown',
    message: error.toString(),
    stackTrace: stackTrace,
  );
}

/// Strips optional `gs://` scheme and trailing slash from a bucket identifier.
///
/// Rejects `gs://bucket/path` specs carrying a non-empty object path with `invalid-url`.
String normalizeStorageBucketSpec(String rawBucket) {
  final trimmed = rawBucket.trim();
  if (trimmed.isEmpty) {
    return '';
  }
  if (trimmed.startsWith('gs://')) {
    final remainder = trimmed.substring(5);
    final slashIndex = remainder.indexOf('/');
    if (slashIndex == -1) {
      if (remainder.isEmpty) {
        throw FirebaseException(
          plugin: 'firebase_storage',
          code: 'invalid-url',
          message: 'Bucket URL "$rawBucket" is missing a bucket name.',
        );
      }
      return remainder;
    }
    final bucketPart = remainder.substring(0, slashIndex);
    final pathPart = remainder.substring(slashIndex + 1);
    if (bucketPart.isEmpty || pathPart.isNotEmpty) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'invalid-url',
        message: 'Bucket specification "$rawBucket" must not contain an object path.',
      );
    }
    return bucketPart;
  }
  if (trimmed.contains('://') || trimmed.contains('/')) {
    throw FirebaseException(
      plugin: 'firebase_storage',
      code: 'invalid-url',
      message: 'Invalid Storage bucket specification "$rawBucket".',
    );
  }
  return trimmed;
}

/// Normalizes a Storage object path to Pyric's bare wire format (`""` for root, no leading/trailing `/`).
String normalizeStorageWirePath(String? rawPath) {
  if (rawPath == null || rawPath.isEmpty) {
    return '';
  }
  final segments = rawPath
      .split('/')
      .where((segment) => segment.isNotEmpty)
      .toList(growable: false);
  if (segments.isEmpty) {
    return '';
  }
  return segments.join('/');
}

/// Normalizes a path for [ReferencePlatform]'s internal `Pointer` (`"/"` for root, bare path otherwise).
String normalizeStoragePointerPath(String? rawPath) {
  final wirePath = normalizeStorageWirePath(rawPath);
  if (wirePath.isEmpty) {
    return '/';
  }
  return wirePath;
}

/// Parses a `gs://` or `http(s)://` Firebase/GCS/Pyric Storage URL into bucket and bare object path.
ParsedStorageUrl parseStorageUrlLocation(String rawUrl) {
  final trimmed = rawUrl.trim();
  if (trimmed.startsWith('gs://')) {
    final remainder = trimmed.substring(5);
    if (remainder.isEmpty) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'invalid-url',
        message: 'Invalid gs:// URL "$rawUrl": missing bucket name.',
      );
    }
    final slashIndex = remainder.indexOf('/');
    if (slashIndex == -1) {
      return ParsedStorageUrl(bucket: remainder, path: '');
    }
    final bucket = remainder.substring(0, slashIndex);
    if (bucket.isEmpty) {
      throw FirebaseException(
        plugin: 'firebase_storage',
        code: 'invalid-url',
        message: 'Invalid gs:// URL "$rawUrl": empty bucket name.',
      );
    }
    final rawPath = remainder.substring(slashIndex + 1);
    return ParsedStorageUrl(
      bucket: bucket,
      path: normalizeStorageWirePath(rawPath),
    );
  }

  final uri = Uri.tryParse(trimmed);
  final hasHttpScheme =
      uri != null && (uri.scheme == 'http' || uri.scheme == 'https') && uri.host.isNotEmpty;
  if (!hasHttpScheme) {
    throw FirebaseException(
      plugin: 'firebase_storage',
      code: 'invalid-argument',
      message: 'Storage refFromURL expected a gs:// or http(s):// URL, got "$rawUrl".',
    );
  }

  // Match `/v0/b/<bucket>/o[/<encodedPath>]` or `/__pyric/storage/v0/b/<bucket>/o[/<encodedPath>]`.
  final rawPath = uri.path;
  const v0Marker = '/v0/b/';
  final markerIdx = rawPath.indexOf(v0Marker);
  if (markerIdx != -1) {
    final prefix = rawPath.substring(0, markerIdx);
    final validPrefix = prefix.isEmpty || prefix == '/__pyric/storage';
    if (validPrefix) {
      final tail = rawPath.substring(markerIdx + v0Marker.length);
      final slashIdx = tail.indexOf('/');
      if (slashIdx > 0) {
        final bucket = Uri.decodeComponent(tail.substring(0, slashIdx));
        final afterBucket = tail.substring(slashIdx + 1);
        if (afterBucket == 'o' || afterBucket == 'o/') {
          final queryName = uri.queryParameters['name'];
          return ParsedStorageUrl(
            bucket: bucket,
            path: normalizeStorageWirePath(queryName),
          );
        }
        if (afterBucket.startsWith('o/')) {
          final encodedObjectPath = afterBucket.substring(2);
          final decodedObjectPath = Uri.decodeComponent(encodedObjectPath);
          return ParsedStorageUrl(
            bucket: bucket,
            path: normalizeStorageWirePath(decodedObjectPath),
          );
        }
      }
    }
  }

  // Match `https://storage.googleapis.com/<bucket>/<objectPath>` or `<bucket>.storage.googleapis.com/<objectPath>`.
  if (uri.host == 'storage.googleapis.com' || uri.host == 'storage.cloud.google.com') {
    final stripped = rawPath.startsWith('/') ? rawPath.substring(1) : rawPath;
    if (stripped.isNotEmpty) {
      final slashIdx = stripped.indexOf('/');
      if (slashIdx == -1) {
        return ParsedStorageUrl(
          bucket: Uri.decodeComponent(stripped),
          path: '',
        );
      }
      final bucket = Uri.decodeComponent(stripped.substring(0, slashIdx));
      final objectPath = stripped
          .substring(slashIdx + 1)
          .split('/')
          .where((s) => s.isNotEmpty)
          .map(Uri.decodeComponent)
          .join('/');
      if (bucket.isNotEmpty) {
        return ParsedStorageUrl(bucket: bucket, path: objectPath);
      }
    }
  }

  if (uri.host.endsWith('.storage.googleapis.com')) {
    final bucket = uri.host.substring(
      0,
      uri.host.length - '.storage.googleapis.com'.length,
    );
    if (bucket.isNotEmpty) {
      final decodedSegments = uri.pathSegments
          .where((s) => s.isNotEmpty)
          .map(Uri.decodeComponent)
          .join('/');
      return ParsedStorageUrl(bucket: bucket, path: decodedSegments);
    }
  }

  throw FirebaseException(
    plugin: 'firebase_storage',
    code: 'invalid-url',
    message: 'Unrecognized Firebase Storage HTTP URL "$rawUrl".',
  );
}

int? _parseWireTimestampMillis(Object? millisRaw, Object? isoRaw) {
  if (millisRaw is num) {
    return millisRaw.toInt();
  }
  if (millisRaw is String && millisRaw.isNotEmpty) {
    final asInt = int.tryParse(millisRaw);
    if (asInt != null) {
      return asInt;
    }
    final parsedMillisStr = DateTime.tryParse(millisRaw);
    if (parsedMillisStr != null) {
      return parsedMillisStr.millisecondsSinceEpoch;
    }
  }
  if (isoRaw is String && isoRaw.isNotEmpty) {
    final parsedIso = DateTime.tryParse(isoRaw);
    if (parsedIso != null) {
      return parsedIso.millisecondsSinceEpoch;
    }
  }
  return null;
}

/// Decodes a Pyric Storage metadata JSON object into a FlutterFire [FullMetadata].
FullMetadata decodeWireFullMetadata(
  Object? raw, {
  String? fallbackBucket,
  String? fallbackPath,
}) {
  if (raw is! Map) {
    throw FirebaseException(
      plugin: 'firebase_storage',
      code: 'unknown',
      message: 'Storage metadata response from Pyric bridge was not an object.',
    );
  }

  final wireFullPath = (raw['fullPath'] as String?) ?? fallbackPath ?? '';
  final normalizedPath = normalizeStorageWirePath(wireFullPath);
  final resolvedName = (raw['name'] as String?) ??
      (normalizedPath.isEmpty ? '' : normalizedPath.split('/').last);

  String? resolvedBucket = raw['bucket'] as String?;
  if ((resolvedBucket == null || resolvedBucket.isEmpty) &&
      fallbackBucket != null &&
      fallbackBucket.isNotEmpty) {
    resolvedBucket = fallbackBucket;
  }

  Map<String, String>? customMetadata;
  final rawCustom = raw['customMetadata'];
  if (rawCustom is Map) {
    customMetadata = <String, String>{};
    rawCustom.forEach((Object? key, Object? value) {
      if (key != null && value != null) {
        customMetadata![key.toString()] = value.toString();
      }
    });
  }

  final metageneration = raw['metageneration']?.toString();
  final metadataGeneration =
      (raw['metadataGeneration'] ?? raw['metageneration'])?.toString();
  final generation = raw['generation']?.toString();
  final sizeRaw = raw['size'];
  final size = sizeRaw is num
      ? sizeRaw.toInt()
      : (sizeRaw is String ? int.tryParse(sizeRaw) : null);

  final creationTimeMillis = _parseWireTimestampMillis(
    raw['creationTimeMillis'],
    raw['timeCreated'],
  );
  final updatedTimeMillis = _parseWireTimestampMillis(
    raw['updatedTimeMillis'],
    raw['updated'],
  );

  return PyricFullMetadata(<String, dynamic>{
    'bucket': resolvedBucket,
    'fullPath': normalizedPath,
    'name': resolvedName,
    'size': size,
    'generation': generation,
    'metageneration': metageneration,
    'metadataGeneration': metadataGeneration,
    'md5Hash': raw['md5Hash'] as String?,
    'contentType': raw['contentType'] as String?,
    'cacheControl': raw['cacheControl'] as String?,
    'contentDisposition': raw['contentDisposition'] as String?,
    'contentEncoding': raw['contentEncoding'] as String?,
    'contentLanguage': raw['contentLanguage'] as String?,
    'creationTimeMillis': creationTimeMillis,
    'updatedTimeMillis': updatedTimeMillis,
    'customMetadata': customMetadata,
  });
}

/// Serializes [SettableMetadata] into the wire `metadata` map accepted by `storage.putBytes` / `storage.beginUpload`.
Map<String, dynamic>? encodeWireSettableMetadata(SettableMetadata? metadata) {
  if (metadata == null) {
    return null;
  }
  final wire = <String, dynamic>{};
  if (metadata.contentType != null) {
    wire['contentType'] = metadata.contentType;
  }
  if (metadata.cacheControl != null) {
    wire['cacheControl'] = metadata.cacheControl;
  }
  if (metadata.contentDisposition != null) {
    wire['contentDisposition'] = metadata.contentDisposition;
  }
  if (metadata.contentEncoding != null) {
    wire['contentEncoding'] = metadata.contentEncoding;
  }
  if (metadata.contentLanguage != null) {
    wire['contentLanguage'] = metadata.contentLanguage;
  }
  if (metadata.customMetadata != null) {
    wire['customMetadata'] = Map<String, String>.from(metadata.customMetadata!);
  }
  return wire;
}

/// Builds the `patch` payload for `storage.setMetadata` (`StorageMetadataPatchWire`).
///
/// Unset (`null`) header fields on [metadata] are omitted so existing values remain intact;
/// empty strings clear the header (`null` on the wire). When [metadata.customMetadata] is
/// non-null, any keys present in [existingCustomMetadata] but omitted from [metadata.customMetadata]
/// are patched to `null` so custom metadata updates and `{}` clears match client SDK semantics.
Map<String, dynamic> encodeWireMetadataPatch(
  SettableMetadata metadata, {
  Map<String, String>? existingCustomMetadata,
}) {
  final settable = <String, dynamic>{};
  void putHeader(String key, String? value) {
    if (value == null) {
      return;
    }
    settable[key] = value.isEmpty ? null : value;
  }

  putHeader('contentType', metadata.contentType);
  putHeader('cacheControl', metadata.cacheControl);
  putHeader('contentDisposition', metadata.contentDisposition);
  putHeader('contentEncoding', metadata.contentEncoding);
  putHeader('contentLanguage', metadata.contentLanguage);

  final patch = <String, dynamic>{};
  if (settable.isNotEmpty) {
    patch['settable'] = settable;
  }

  final nextCustom = metadata.customMetadata;
  if (nextCustom != null) {
    final customPatch = <String, String?>{};
    if (existingCustomMetadata != null) {
      for (final oldKey in existingCustomMetadata.keys) {
        if (!nextCustom.containsKey(oldKey)) {
          customPatch[oldKey] = null;
        }
      }
    }
    nextCustom.forEach((String key, String value) {
      customPatch[key] = value;
    });
    patch['customMetadata'] = customPatch;
  }

  return patch;
}

/// Encodes an opaque pagination cursor for [ReferencePlatform.list].
String encodeStorageListPageToken(int offset) {
  final payload = jsonEncode(<String, int>{'o': offset});
  return base64Url.encode(utf8.encode(payload));
}

/// Decodes a pagination cursor produced by [encodeStorageListPageToken].
int decodeStorageListPageToken(String pageToken) {
  try {
    final normalized = base64Url.normalize(pageToken.trim());
    final decodedJson = utf8.decode(base64Url.decode(normalized));
    final map = jsonDecode(decodedJson);
    if (map is Map && map['o'] is int && (map['o'] as int) >= 0) {
      return map['o'] as int;
    }
  } catch (_) {
    // Fall through to structured FirebaseException below.
  }
  throw FirebaseException(
    plugin: 'firebase_storage',
    code: 'invalid-argument',
    message: 'Invalid Storage list pageToken.',
  );
}
