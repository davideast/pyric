import 'package:firebase_core/firebase_core.dart' show FirebaseException;

import '../transport/exceptions.dart';
import 'crashlytics_types.dart';

/// Truncates [input] to [maxChars] characters to match Crashlytics string bounds.
String truncateCrashlyticsString(
  String input, [
  int maxChars = maxCrashlyticsStringChars,
]) {
  if (input.length <= maxChars) {
    return input;
  }
  return input.substring(0, maxChars);
}

/// Validates and normalizes one custom key/value pair for `crashlytics.setCustomKeys`.
///
/// Accepts [bool], [int], [double]/[num], or [String]. Non-finite floating-point
/// values (`NaN`, `Infinity`, `-Infinity`) are converted to their string form so
/// JSON serialization and host inbound validation always receive finite numbers.
({String key, Object value}) normalizeCrashlyticsCustomEntry(
  String key,
  Object value,
) {
  final trimmedKey = key.trim();
  if (trimmedKey.isEmpty) {
    throw ArgumentError.value(
      key,
      'key',
      'Crashlytics custom key must not be empty.',
    );
  }
  final normalizedKey = truncateCrashlyticsString(trimmedKey);
  if (value is bool) {
    return (key: normalizedKey, value: value);
  }
  if (value is int) {
    return (key: normalizedKey, value: value);
  }
  if (value is num) {
    final asDouble = value.toDouble();
    if (!asDouble.isFinite) {
      return (key: normalizedKey, value: asDouble.toString());
    }
    return (key: normalizedKey, value: asDouble);
  }
  if (value is String) {
    return (key: normalizedKey, value: truncateCrashlyticsString(value));
  }
  throw ArgumentError.value(
    value,
    'value',
    'Crashlytics custom key value must be bool, int, num, or String.',
  );
}

/// Normalizes a batch of custom keys (where `null` deletes an existing key on the broker).
Map<String, Object?> normalizeCrashlyticsCustomKeyBatch(
  Map<String, Object?> entries,
) {
  final out = <String, Object?>{};
  for (final entry in entries.entries) {
    final trimmedKey = entry.key.trim();
    if (trimmedKey.isEmpty) {
      throw ArgumentError.value(
        entry.key,
        'keys',
        'Crashlytics custom key must not be empty.',
      );
    }
    final normalizedKey = truncateCrashlyticsString(trimmedKey);
    final rawVal = entry.value;
    if (rawVal == null) {
      out[normalizedKey] = null;
    } else {
      out[normalizedKey] =
          normalizeCrashlyticsCustomEntry(normalizedKey, rawVal).value;
    }
  }
  return out;
}

/// Extracts structured `name`, non-empty `message`, optional `code`, and optional
/// `cause` fields from an arbitrary Dart [exception] object.
({String name, String message, String? code, String? cause})
    extractDartExceptionMetadata(Object? exception) {
  if (exception == null) {
    return (
      name: 'NullThrownError',
      message: 'Null error recorded by FirebaseCrashlytics',
      code: null,
      cause: null,
    );
  }
  if (exception is FirebaseException) {
    final plugin = exception.plugin.trim();
    final rawCode = exception.code.trim();
    String? combinedCode;
    if (rawCode.isNotEmpty) {
      combinedCode = plugin.isNotEmpty && !rawCode.contains('/')
          ? '$plugin/$rawCode'
          : rawCode;
    }
    final msg = (exception.message ?? '').trim();
    return (
      name: exception.runtimeType.toString(),
      message: msg.isNotEmpty ? msg : exception.toString(),
      code: combinedCode,
      cause: null,
    );
  }
  if (exception is String) {
    return (
      name: 'FlutterError',
      message: exception.isNotEmpty ? exception : 'Empty error message',
      code: null,
      cause: null,
    );
  }
  final typeName = exception.runtimeType.toString();
  final rendered = exception.toString().trim();
  return (
    name: typeName,
    message: rendered.isNotEmpty ? rendered : typeName,
    code: null,
    cause: null,
  );
}

/// Formats [stack], falling back to [StackTrace.current] when null or empty,
/// matching FlutterFire `FirebaseCrashlytics.recordError`.
String formatDartStackTrace(StackTrace? stack) {
  if (stack == null) {
    return StackTrace.current.toString().trimRight();
  }
  final text = stack.toString().trimRight();
  if (text.isEmpty) {
    return StackTrace.current.toString().trimRight();
  }
  return text;
}

/// Maps bridge transport failures into [FirebaseException] under `firebase_crashlytics`.
FirebaseException mapCrashlyticsBridgeException(
  Object error, [
  StackTrace? stackTrace,
]) {
  if (error is FirebaseException) {
    return error;
  }
  if (error is PyricBridgeException) {
    var code = error.code.trim();
    if (code.toLowerCase().startsWith('crashlytics/')) {
      code = code.substring('crashlytics/'.length);
    }
    if (code.isEmpty) {
      code = 'unknown';
    }
    return FirebaseException(
      plugin: firebaseCrashlyticsPluginName,
      code: code,
      message: error.message,
      stackTrace: stackTrace,
    );
  }
  return FirebaseException(
    plugin: firebaseCrashlyticsPluginName,
    code: 'unknown',
    message: error.toString(),
    stackTrace: stackTrace,
  );
}
