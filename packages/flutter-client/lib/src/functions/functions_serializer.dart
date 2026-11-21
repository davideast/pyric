/// Protobuf type URL used by the Firebase callable wire protocol for signed 64-bit integers.
const String int64TypeUrl = 'type.googleapis.com/google.protobuf.Int64Value';

/// Protobuf type URL used by the Firebase callable wire protocol for unsigned 64-bit integers.
const String uint64TypeUrl = 'type.googleapis.com/google.protobuf.UInt64Value';

const int _maxJsSafeInteger = 9007199254740991;
const int _minJsSafeInteger = -9007199254740991;

/// Encodes a Dart value into a JSON-encodable callable wire representation.
///
/// Signed 64-bit [int] values outside IEEE-754 53-bit safe integer bounds
/// (`[-9007199254740991, 9007199254740991]`) and [BigInt] values are wrapped as
/// `Int64Value` objects so full 64-bit precision survives JSON parsing.
/// Rejects non-finite [double] values (`NaN`, `Infinity`, `-Infinity`) and
/// maps with non-[String] keys by throwing [ArgumentError].
Object? encodeCallableData(Object? data) {
  if (data == null || data is bool || data is String) {
    return data;
  }
  if (data is int) {
    if (data < _minJsSafeInteger || data > _maxJsSafeInteger) {
      return <String, Object?>{
        '@type': int64TypeUrl,
        'value': data.toString(),
      };
    }
    return data;
  }
  if (data is double) {
    if (!data.isFinite) {
      throw ArgumentError('Cannot encode non-finite number: $data');
    }
    return data;
  }
  if (data is BigInt) {
    return <String, Object?>{
      '@type': int64TypeUrl,
      'value': data.toString(),
    };
  }
  if (data is List) {
    return data.map<Object?>(encodeCallableData).toList(growable: false);
  }
  if (data is Map) {
    final encoded = <String, Object?>{};
    for (final entry in data.entries) {
      final key = entry.key;
      if (key is! String) {
        throw ArgumentError(
          'Callable map keys must be strings, got ${key.runtimeType}',
        );
      }
      encoded[key] = encodeCallableData(entry.value);
    }
    return encoded;
  }
  throw ArgumentError(
    'Unsupported type in callable request payload: ${data.runtimeType}',
  );
}

/// Decodes a parsed JSON value from a callable wire response into Dart values.
///
/// Unwraps `Int64Value` and `UInt64Value` protobuf wrappers into native 64-bit
/// Dart [int] values (falling back to [BigInt] when an unsigned 64-bit integer
/// exceeds signed 64-bit range). Throws [FormatException] on unknown `@type`
/// wrappers or malformed integer strings.
Object? decodeCallableData(Object? json) {
  if (json == null || json is bool || json is num || json is String) {
    return json;
  }
  if (json is List) {
    return json.map<Object?>(decodeCallableData).toList();
  }
  if (json is Map) {
    final rawType = json['@type'];
    if (rawType is String) {
      if (rawType == int64TypeUrl || rawType == uint64TypeUrl) {
        final rawValue = json['value'];
        if (rawValue is! String) {
          throw FormatException(
            'Expected string value for $rawType, got ${rawValue.runtimeType}',
          );
        }
        final asInt = int.tryParse(rawValue);
        if (asInt != null) {
          return asInt;
        }
        final asBigInt = BigInt.tryParse(rawValue);
        if (asBigInt != null) {
          return asBigInt;
        }
        final asDouble = double.tryParse(rawValue);
        if (asDouble != null && asDouble.isFinite) {
          return asDouble;
        }
        throw FormatException('Invalid integer value for $rawType: $rawValue');
      }
      throw FormatException('Unsupported @type in callable payload: $rawType');
    }

    final decoded = <String, dynamic>{};
    for (final entry in json.entries) {
      decoded[entry.key.toString()] = decodeCallableData(entry.value);
    }
    return decoded;
  }
  return json;
}
