import 'dart:convert';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;
import 'package:firebase_storage_platform_interface/firebase_storage_platform_interface.dart';

final RegExp _standardBase64Pattern = RegExp(r'^[A-Za-z0-9+/]*={0,2}$');
final RegExp _urlSafeBase64Pattern = RegExp(r'^[A-Za-z0-9_-]*={0,2}$');

/// Decoded byte payload and effective [SettableMetadata] produced from [ReferencePlatform.putString].
class DecodedPutStringPayload {
  final Uint8List bytes;
  final SettableMetadata metadata;

  const DecodedPutStringPayload({
    required this.bytes,
    required this.metadata,
  });
}

/// Decodes a [String] according to [PutStringFormat] and merges inferred `contentType` into [metadata].
///
/// Throws a `firebase_storage` [FirebaseException] with code `invalid-format` synchronously
/// when [data] is malformed for [format].
DecodedPutStringPayload decodePutStringPayload(
  String data,
  PutStringFormat format, [
  SettableMetadata? metadata,
]) {
  switch (format) {
    case PutStringFormat.raw:
      return DecodedPutStringPayload(
        bytes: Uint8List.fromList(utf8.encode(data)),
        metadata: _mergeInferredContentType(
          metadata,
          'text/plain; charset=utf-8',
        ),
      );
    case PutStringFormat.base64:
      return DecodedPutStringPayload(
        bytes: _decodeStandardBase64(data),
        metadata: _mergeInferredContentType(
          metadata,
          'application/octet-stream',
        ),
      );
    case PutStringFormat.base64Url:
      return DecodedPutStringPayload(
        bytes: _decodeUrlSafeBase64(data),
        metadata: _mergeInferredContentType(
          metadata,
          'application/octet-stream',
        ),
      );
    case PutStringFormat.dataUrl:
      return _decodeDataUrl(data, metadata);
  }
}

SettableMetadata _mergeInferredContentType(
  SettableMetadata? metadata,
  String? inferredContentType,
) {
  final callerContentType = metadata?.contentType;
  final effectiveContentType =
      (callerContentType != null && callerContentType.isNotEmpty)
          ? callerContentType
          : inferredContentType;
  return SettableMetadata(
    cacheControl: metadata?.cacheControl,
    contentDisposition: metadata?.contentDisposition,
    contentEncoding: metadata?.contentEncoding,
    contentLanguage: metadata?.contentLanguage,
    contentType: effectiveContentType,
    customMetadata: metadata?.customMetadata == null
        ? null
        : Map<String, String>.from(metadata!.customMetadata!),
  );
}

Uint8List _decodeStandardBase64(String raw) {
  if (raw.isEmpty) {
    return Uint8List(0);
  }
  if (!_standardBase64Pattern.hasMatch(raw)) {
    throw _invalidFormat('String is not valid standard base64.');
  }
  final stripped = raw.replaceAll('=', '');
  final paddingCount = raw.length - stripped.length;
  if (paddingCount > 2 || stripped.length % 4 == 1) {
    throw _invalidFormat('Invalid base64 length or padding.');
  }
  if (paddingCount > 0 && raw.length % 4 != 0) {
    throw _invalidFormat('Padded base64 string length must be a multiple of 4.');
  }
  final normalized = _padBase64(stripped);
  try {
    return Uint8List.fromList(base64.decode(normalized));
  } on FormatException catch (error) {
    throw _invalidFormat('Invalid base64 payload: ${error.message}');
  }
}

Uint8List _decodeUrlSafeBase64(String raw) {
  if (raw.isEmpty) {
    return Uint8List(0);
  }
  if (!_urlSafeBase64Pattern.hasMatch(raw)) {
    throw _invalidFormat('String is not valid base64url.');
  }
  final stripped = raw.replaceAll('=', '');
  final paddingCount = raw.length - stripped.length;
  if (paddingCount > 2 || stripped.length % 4 == 1) {
    throw _invalidFormat('Invalid base64url length or padding.');
  }
  if (paddingCount > 0 && raw.length % 4 != 0) {
    throw _invalidFormat('Padded base64url string length must be a multiple of 4.');
  }
  final normalized = _padBase64(stripped);
  try {
    return Uint8List.fromList(base64Url.decode(normalized));
  } on FormatException catch (error) {
    throw _invalidFormat('Invalid base64url payload: ${error.message}');
  }
}

DecodedPutStringPayload _decodeDataUrl(
  String raw,
  SettableMetadata? metadata,
) {
  if (raw.length < 6 || raw.substring(0, 5).toLowerCase() != 'data:') {
    throw _invalidFormat('Data URL must start with "data:".');
  }
  final commaIndex = raw.indexOf(',');
  if (commaIndex < 5) {
    throw _invalidFormat('Data URL is missing a comma separator.');
  }

  final header = raw.substring(5, commaIndex);
  final payload = raw.substring(commaIndex + 1);

  var isBase64 = false;
  var mediaTypeSpec = header;

  if (header.isNotEmpty) {
    final segments = header.split(';');
    if (segments.length >= 2 && segments.last.toLowerCase() == 'base64') {
      isBase64 = true;
      mediaTypeSpec = segments.sublist(0, segments.length - 1).join(';');
    }
    if (mediaTypeSpec.isNotEmpty) {
      final leadingType = mediaTypeSpec.split(';').first.trim();
      if (leadingType.isNotEmpty && !leadingType.contains('/')) {
        throw _invalidFormat('Data URL media type "$leadingType" is invalid.');
      }
    }
  }

  String? inferredContentType;
  if (mediaTypeSpec.trim().isNotEmpty) {
    inferredContentType = mediaTypeSpec.trim();
  } else if (!isBase64) {
    inferredContentType = 'text/plain;charset=utf-8';
  } else {
    inferredContentType = 'application/octet-stream';
  }

  final Uint8List decodedBytes;
  if (isBase64) {
    String unescapedPayload = payload;
    if (payload.contains('%')) {
      try {
        unescapedPayload = Uri.decodeComponent(payload);
      } catch (error) {
        throw _invalidFormat('Invalid percent-encoding in base64 data URL: $error');
      }
    }
    decodedBytes = _decodeStandardBase64(unescapedPayload);
  } else {
    try {
      final decodedText = Uri.decodeComponent(payload);
      decodedBytes = Uint8List.fromList(utf8.encode(decodedText));
    } catch (error) {
      throw _invalidFormat('Invalid percent-encoding in data URL: $error');
    }
  }

  return DecodedPutStringPayload(
    bytes: decodedBytes,
    metadata: _mergeInferredContentType(metadata, inferredContentType),
  );
}

String _padBase64(String unpadded) {
  final remainder = unpadded.length % 4;
  if (remainder == 2) {
    return '$unpadded==';
  }
  if (remainder == 3) {
    return '$unpadded=';
  }
  return unpadded;
}

FirebaseException _invalidFormat(String message) {
  return FirebaseException(
    plugin: 'firebase_storage',
    code: 'invalid-format',
    message: message,
  );
}
