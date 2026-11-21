import 'package:firebase_core/firebase_core.dart' show FirebaseException;

final RegExp _schemeUrlPattern = RegExp(r'^[A-Za-z]+://');
final RegExp _dataUriPattern = RegExp(r'^data:[^,]*,', caseSensitive: false);
final RegExp _gsSchemePrefix = RegExp(r'^gs://', caseSensitive: false);
final RegExp _validBucketNamePattern = RegExp(r'^[A-Za-z0-9.\-_]+$');
final RegExp _malformedPercentEscapePattern = RegExp(r'%(?![0-9A-Fa-f]{2})');
final RegExp _restVersionPrefixPattern = RegExp(
  r'^(?:|/__pyric/storage)/v[A-Za-z0-9_]+/b/([^/]+)/(o(?:/.*)?)$',
);

/// Parsed bucket and object path extracted from a `gs://` or `http(s)://` Storage URL.
class ParsedStorageUrl {
  final String bucket;
  final String path;

  const ParsedStorageUrl({
    required this.bucket,
    required this.path,
  });
}

/// Whether [rawValue] starts with an explicit URI scheme (`<scheme>://`).
bool isStorageSchemeUrl(String? rawValue) {
  if (rawValue == null || rawValue.isEmpty) {
    return false;
  }
  return _schemeUrlPattern.hasMatch(rawValue.trim());
}

/// Whether [rawValue] is a `data:` URI (`data:[<mediatype>][;base64],<payload>`).
bool isStorageDataUri(String? rawValue) {
  if (rawValue == null || rawValue.isEmpty) {
    return false;
  }
  final trimmed = rawValue.trim();
  return _dataUriPattern.hasMatch(trimmed) ||
      trimmed.toLowerCase().startsWith('data:');
}

/// Whether `storage.ref(value)` should treat [rawValue] as a URL rather than an object path.
bool isStorageUrlInput(String? rawValue) {
  return isStorageSchemeUrl(rawValue) || isStorageDataUri(rawValue);
}

/// Validates that a relative path passed to `ReferencePlatform.child(path)` is not a URL.
void validateRelativeStorageChildPath(String rawChildPath) {
  if (isStorageDataUri(rawChildPath)) {
    throw _invalidUrlException(
      rawChildPath,
      'A data: URI carries object bytes rather than a Storage object location.',
    );
  }
  if (isStorageSchemeUrl(rawChildPath)) {
    throw FirebaseException(
      plugin: 'firebase_storage',
      code: 'invalid-argument',
      message:
          'Reference.child() expects a relative object path, not a URL ("$rawChildPath").',
    );
  }
}

/// Strips optional `gs://` scheme and trailing slash from a bucket identifier.
///
/// Rejects `gs://bucket/path` specs carrying a non-empty object path with `invalid-url`.
String normalizeStorageBucketSpec(String rawBucket) {
  final trimmed = rawBucket.trim();
  if (trimmed.isEmpty) {
    return '';
  }
  if (_gsSchemePrefix.hasMatch(trimmed)) {
    final remainder = trimmed.substring(5);
    final slashIndex = remainder.indexOf('/');
    if (slashIndex == -1) {
      if (remainder.isEmpty || !_validBucketNamePattern.hasMatch(remainder)) {
        throw _invalidUrlException(
          rawBucket,
          'Bucket URL is missing a valid bucket name.',
        );
      }
      return remainder;
    }
    final bucketPart = remainder.substring(0, slashIndex);
    final pathPart = remainder.substring(slashIndex + 1);
    if (bucketPart.isEmpty ||
        pathPart.isNotEmpty ||
        !_validBucketNamePattern.hasMatch(bucketPart)) {
      throw _invalidUrlException(
        rawBucket,
        'Bucket specification must not contain an object path.',
      );
    }
    return bucketPart;
  }
  if (trimmed.contains('://') ||
      trimmed.contains('/') ||
      isStorageDataUri(trimmed)) {
    throw _invalidUrlException(
      rawBucket,
      'Invalid Storage bucket specification.',
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
  if (isStorageDataUri(trimmed)) {
    throw _invalidUrlException(
      rawUrl,
      'A data: URI carries object bytes rather than a Storage object location.',
    );
  }

  if (_gsSchemePrefix.hasMatch(trimmed)) {
    final remainder = trimmed.substring(5);
    if (remainder.isEmpty) {
      throw _invalidUrlException(rawUrl, 'Missing bucket name in gs:// URL.');
    }
    final slashIndex = remainder.indexOf('/');
    final bucket =
        slashIndex == -1 ? remainder : remainder.substring(0, slashIndex);
    if (bucket.isEmpty || !_validBucketNamePattern.hasMatch(bucket)) {
      throw _invalidUrlException(rawUrl, 'Invalid bucket name in gs:// URL.');
    }
    final rawPath =
        slashIndex == -1 ? '' : remainder.substring(slashIndex + 1);
    return ParsedStorageUrl(
      bucket: bucket,
      path: normalizeStorageWirePath(rawPath),
    );
  }

  if (!isStorageSchemeUrl(trimmed)) {
    throw FirebaseException(
      plugin: 'firebase_storage',
      code: 'invalid-argument',
      message:
          'Storage refFromURL expected a gs:// or http(s):// URL, got "$rawUrl".',
    );
  }

  final hashIdx = trimmed.indexOf('#');
  final beforeFragment =
      hashIdx == -1 ? trimmed : trimmed.substring(0, hashIdx);
  if (_malformedPercentEscapePattern.hasMatch(beforeFragment)) {
    throw _invalidUrlException(
      rawUrl,
      'Malformed percent-encoding in Storage URL.',
    );
  }

  final uri = Uri.tryParse(trimmed);
  final schemeLower = uri?.scheme.toLowerCase();
  final hasHttpScheme = uri != null &&
      (schemeLower == 'http' || schemeLower == 'https') &&
      uri.host.isNotEmpty;
  if (!hasHttpScheme) {
    throw _invalidUrlException(
      rawUrl,
      'Expected a gs:// URL or an http(s):// Storage download URL.',
    );
  }

  // Match `/v<ver>/b/<bucket>/o[/<encodedPath>]` or `/__pyric/storage/v<ver>/b/<bucket>/o[/<encodedPath>]`.
  final restMatch = _restVersionPrefixPattern.firstMatch(uri.path);
  if (restMatch != null) {
    final bucket = _decodeUriComponentOrInvalidUrl(restMatch.group(1)!, rawUrl);
    if (bucket.isEmpty || !_validBucketNamePattern.hasMatch(bucket)) {
      throw _invalidUrlException(rawUrl, 'Invalid bucket name in Storage URL.');
    }
    final afterBucket = restMatch.group(2)!;
    if (afterBucket == 'o' || afterBucket == 'o/') {
      final queryName = _extractDecodedQueryParam(uri.query, 'name', rawUrl);
      return ParsedStorageUrl(
        bucket: bucket,
        path: normalizeStorageWirePath(queryName),
      );
    }
    if (afterBucket.startsWith('o/')) {
      final encodedObjectPath = afterBucket.substring(2);
      final decodedObjectPath =
          _decodeUriComponentOrInvalidUrl(encodedObjectPath, rawUrl);
      return ParsedStorageUrl(
        bucket: bucket,
        path: normalizeStorageWirePath(decodedObjectPath),
      );
    }
  }

  final hostLower = uri.host.toLowerCase();
  if (hostLower == 'storage.googleapis.com' ||
      hostLower == 'storage.cloud.google.com') {
    final stripped =
        uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
    if (stripped.isNotEmpty) {
      final slashIdx = stripped.indexOf('/');
      if (slashIdx == -1) {
        final bucket = _decodeUriComponentOrInvalidUrl(stripped, rawUrl);
        if (bucket.isNotEmpty && _validBucketNamePattern.hasMatch(bucket)) {
          return ParsedStorageUrl(bucket: bucket, path: '');
        }
      } else {
        final bucket = _decodeUriComponentOrInvalidUrl(
          stripped.substring(0, slashIdx),
          rawUrl,
        );
        final objectPath = stripped
            .substring(slashIdx + 1)
            .split('/')
            .where((segment) => segment.isNotEmpty)
            .map((segment) => _decodeUriComponentOrInvalidUrl(segment, rawUrl))
            .join('/');
        if (bucket.isNotEmpty && _validBucketNamePattern.hasMatch(bucket)) {
          return ParsedStorageUrl(
            bucket: bucket,
            path: normalizeStorageWirePath(objectPath),
          );
        }
      }
    }
  }

  if (hostLower.endsWith('.storage.googleapis.com')) {
    final bucket = uri.host.substring(
      0,
      uri.host.length - '.storage.googleapis.com'.length,
    );
    if (bucket.isNotEmpty && _validBucketNamePattern.hasMatch(bucket)) {
      final decodedPath = uri.path
          .split('/')
          .where((segment) => segment.isNotEmpty)
          .map((segment) => _decodeUriComponentOrInvalidUrl(segment, rawUrl))
          .join('/');
      return ParsedStorageUrl(
        bucket: bucket,
        path: normalizeStorageWirePath(decodedPath),
      );
    }
  }

  throw _invalidUrlException(
    rawUrl,
    'Unrecognized Firebase Storage HTTP URL.',
  );
}

String _decodeUriComponentOrInvalidUrl(String encoded, String rawUrl) {
  try {
    return Uri.decodeComponent(encoded);
  } catch (_) {
    throw _invalidUrlException(
      rawUrl,
      'Malformed percent-encoding in Storage URL.',
    );
  }
}

String? _extractDecodedQueryParam(
  String rawQuery,
  String targetKey,
  String rawUrl,
) {
  if (rawQuery.isEmpty) {
    return null;
  }
  for (final pair in rawQuery.split('&')) {
    if (pair.isEmpty) {
      continue;
    }
    final eqIdx = pair.indexOf('=');
    final rawKey = eqIdx == -1 ? pair : pair.substring(0, eqIdx);
    final rawVal = eqIdx == -1 ? '' : pair.substring(eqIdx + 1);
    final decodedKey = _decodeUriComponentOrInvalidUrl(
      rawKey.replaceAll('+', '%20'),
      rawUrl,
    );
    if (decodedKey == targetKey) {
      return _decodeUriComponentOrInvalidUrl(
        rawVal.replaceAll('+', '%20'),
        rawUrl,
      );
    }
  }
  return null;
}

FirebaseException _invalidUrlException(String rawUrl, String detail) {
  final preview =
      rawUrl.length > 96 ? '${rawUrl.substring(0, 96)}...' : rawUrl;
  return FirebaseException(
    plugin: 'firebase_storage',
    code: 'invalid-url',
    message: 'Invalid Storage URL "$preview": $detail',
  );
}
