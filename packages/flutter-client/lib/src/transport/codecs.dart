import 'dart:convert';
import 'dart:typed_data';

import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';

import 'sentinels.dart';

export 'sentinels.dart';

// ─── Base64 Encoding & Decoding Helpers ─────────────────────────────────────

/// Encode a [Uint8List] as RFC 4648 unpadded base64url string (`-`/`_`, no `=`).
String base64UrlEncodeUnpadded(Uint8List bytes) {
  return base64Url.encode(bytes).replaceAll('=', '');
}

/// Decode an RFC 4648 base64url string back to [Uint8List].
Uint8List base64UrlDecodeUnpadded(String input) {
  var normalized = input.replaceAll('-', '+').replaceAll('_', '/');
  final remainder = normalized.length % 4;
  if (remainder != 0) {
    normalized += '=' * (4 - remainder);
  }
  return Uint8List.fromList(base64.decode(normalized));
}

/// Decode a standard base64 string back to [Uint8List].
Uint8List base64StdDecode(String input) {
  return Uint8List.fromList(base64.decode(base64.normalize(input)));
}

// ─── Reference Holder & Resolver ────────────────────────────────────────────

/// Lightweight holder for DocumentReference path decoded from wire markers.
class PyricDocumentReferenceHolder {
  final String path;

  const PyricDocumentReferenceHolder(this.path);

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PyricDocumentReferenceHolder && other.path == path;

  @override
  int get hashCode => path.hashCode;

  @override
  String toString() => 'PyricDocumentReferenceHolder($path)';
}

/// Function signature to resolve a decoded path into a platform document reference.
typedef DocumentReferenceResolver = dynamic Function(String path);

// ─── Value Serializer (Dart -> Wire JSON) ───────────────────────────────────

/// Sentinel marker types recognizable from incoming map payloads.
const _sentinelTypes = <String>{
  'serverTimestamp',
  'increment',
  'arrayUnion',
  'arrayRemove',
  'deleteField',
  'delete',
};

/// Encodes a Dart value into its plain-JSON Pyric wire representation.
dynamic encodeValue(dynamic value) {
  if (value == null) return null;
  if (value is bool || value is num || value is String) return value;

  if (value is PyricSentinel) {
    return value.toWireSentinel();
  }

  if (value is Timestamp) {
    return {
      '__type': 'timestamp',
      'seconds': value.seconds,
      'nanos': value.nanoseconds,
    };
  }

  if (value is DateTime) {
    final ts = Timestamp.fromDate(value);
    return {
      '__type': 'timestamp',
      'seconds': ts.seconds,
      'nanos': ts.nanoseconds,
    };
  }

  if (value is GeoPoint) {
    return {
      '__type': 'latlng',
      'lat': value.latitude,
      'lng': value.longitude,
    };
  }

  if (value is Blob) {
    return {
      '__type': 'bytes',
      'base64': base64UrlEncodeUnpadded(value.bytes),
    };
  }

  if (value is Uint8List) {
    return {
      '__type': 'bytes',
      'base64': base64UrlEncodeUnpadded(value),
    };
  }

  if (value is PyricDocumentReferenceHolder) {
    return {
      '__type': 'reference',
      'path': value.path,
    };
  }

  if (value is DocumentReferencePlatform) {
    return {
      '__type': 'reference',
      'path': value.path,
    };
  }

  if (value is List) {
    return value.map(encodeValue).toList();
  }

  if (value is Map) {
    // 1. Direct __sentinel envelope
    if (value.containsKey('__sentinel')) {
      final sentinel = value['__sentinel'];
      if (sentinel == 'serverTimestamp' || sentinel == 'deleteField') {
        return {'__sentinel': sentinel};
      }
      if (sentinel == 'increment') {
        return {'__sentinel': 'increment', 'n': value['n']};
      }
      if (sentinel == 'arrayUnion' || sentinel == 'arrayRemove') {
        final rawValues = value['values'] as List? ?? const [];
        return {
          '__sentinel': sentinel,
          'values': rawValues.map(encodeValue).toList(),
        };
      }
    }

    // 2. Transmutation of __type sentinel markers
    if (value.containsKey('__type') && _sentinelTypes.contains(value['__type'])) {
      final t = value['__type'];
      if (t == 'serverTimestamp') {
        return const {'__sentinel': 'serverTimestamp'};
      }
      if (t == 'increment') {
        return {'__sentinel': 'increment', 'n': value['value'] ?? value['n']};
      }
      if (t == 'arrayUnion') {
        final rawValues = value['values'] as List? ?? const [];
        return {
          '__sentinel': 'arrayUnion',
          'values': rawValues.map(encodeValue).toList(),
        };
      }
      if (t == 'arrayRemove') {
        final rawValues = value['values'] as List? ?? const [];
        return {
          '__sentinel': 'arrayRemove',
          'values': rawValues.map(encodeValue).toList(),
        };
      }
      if (t == 'deleteField' || t == 'delete') {
        return const {'__sentinel': 'deleteField'};
      }
    }

    // 3. Regular Map: recursively encode entries
    final out = <String, dynamic>{};
    for (final entry in value.entries) {
      out[entry.key.toString()] = encodeValue(entry.value);
    }
    return out;
  }

  // Check dynamic duck-typing for custom types
  try {
    final dynamic dyn = value;
    if (dyn.path is String) {
      return {
        '__type': 'reference',
        'path': dyn.path as String,
      };
    }
  } catch (_) {}

  throw ArgumentError.value(
    value,
    'value',
    'Cannot serialize ${value.runtimeType} for Pyric bridge wire.',
  );
}

/// Encodes an entire document payload map for write operations.
Map<String, dynamic> encodeWriteData(Map<String, dynamic> data) {
  final encoded = encodeValue(data);
  if (encoded is Map<String, dynamic>) return encoded;
  if (encoded is Map) return Map<String, dynamic>.from(encoded);
  return <String, dynamic>{};
}

// ─── Value Deserializer (Wire JSON -> Dart) ─────────────────────────────────

/// Decodes a wire JSON structure, reviving `__type` and compat type markers.
dynamic decodeValue(
  dynamic value, {
  DocumentReferenceResolver? referenceResolver,
}) {
  if (value == null) return null;
  if (value is bool || value is num || value is String) return value;

  if (value is List) {
    return value
        .map((item) => decodeValue(item, referenceResolver: referenceResolver))
        .toList();
  }

  if (value is Map) {
    final map = value;

    // 1. Primary __type marker
    final dynamic typeMarker = map['__type'];
    if (typeMarker is String) {
      switch (typeMarker) {
        case 'timestamp':
          final seconds = (map['seconds'] as num).toInt();
          final nanos = (map['nanos'] as num).toInt();
          return Timestamp(seconds, nanos);
        case 'latlng':
          final lat = (map['lat'] as num).toDouble();
          final lng = (map['lng'] as num).toDouble();
          return GeoPoint(lat, lng);
        case 'bytes':
          final b64 = map['base64'] as String;
          return Blob(base64UrlDecodeUnpadded(b64));
        case 'reference':
          final path = map['path'] as String;
          return referenceResolver != null
              ? referenceResolver(path)
              : PyricDocumentReferenceHolder(path);
      }
    }

    // 2. Compatibility `type` marker (firebase/firestore SDK style)
    final dynamic compatType = map['type'];
    if (compatType is String) {
      switch (compatType) {
        case 'firestore/timestamp/1.0':
          final seconds = (map['seconds'] as num).toInt();
          final nanos = (map['nanoseconds'] as num).toInt();
          return Timestamp(seconds, nanos);
        case 'firestore/geoPoint/1.0':
          final lat = (map['latitude'] as num).toDouble();
          final lng = (map['longitude'] as num).toDouble();
          return GeoPoint(lat, lng);
        case 'firestore/bytes/1.0':
          final b64 = map['bytes'] as String;
          return Blob(base64StdDecode(b64));
      }
    }

    // 3. Regular Map: recursively decode all entries
    final out = <String, dynamic>{};
    for (final entry in map.entries) {
      out[entry.key.toString()] = decodeValue(
        entry.value,
        referenceResolver: referenceResolver,
      );
    }
    return out;
  }

  return value;
}

/// Decodes document data from the `{ "json": string }` envelope returned by bridge.
Map<String, dynamic> decodeDocData(
  dynamic wireData, {
  DocumentReferenceResolver? referenceResolver,
}) {
  if (wireData == null) return <String, dynamic>{};

  if (wireData is String) {
    try {
      final parsed = jsonDecode(wireData);
      return decodeDocData(parsed, referenceResolver: referenceResolver);
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  if (wireData is Map) {
    if (wireData.containsKey('json') && wireData['json'] is String) {
      final jsonStr = wireData['json'] as String;
      try {
        final parsed = jsonDecode(jsonStr);
        final decoded = decodeValue(parsed, referenceResolver: referenceResolver);
        if (decoded is Map<String, dynamic>) return decoded;
        if (decoded is Map) return Map<String, dynamic>.from(decoded);
        return <String, dynamic>{};
      } catch (_) {
        return <String, dynamic>{};
      }
    }

    final decoded = decodeValue(wireData, referenceResolver: referenceResolver);
    if (decoded is Map<String, dynamic>) return decoded;
    if (decoded is Map) return Map<String, dynamic>.from(decoded);
  }

  return <String, dynamic>{};
}
