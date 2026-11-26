import 'dart:convert';

import '../auth/auth_lens.dart';
import 'exceptions.dart';

/// Decodes a raw WebSocket payload into a JSON map, or `null` if invalid.
Map<String, dynamic>? decodeBridgeFrame(dynamic raw) {
  try {
    if (raw is String) {
      final decoded = jsonDecode(raw);
      return decoded is Map ? Map<String, dynamic>.from(decoded) : null;
    }
    if (raw is List<int>) {
      final decoded = jsonDecode(utf8.decode(raw));
      return decoded is Map ? Map<String, dynamic>.from(decoded) : null;
    }
    if (raw is Map) {
      return Map<String, dynamic>.from(raw);
    }
  } catch (_) {
    return null;
  }
  return null;
}

/// Parses a `remote-lens` worker event frame into an [AuthLens], or `null`
/// if the frame is not a recognized remote-lens event.
AuthLens? parseRemoteLensEvent(Map<String, dynamic> msg) {
  final event = msg['event'] as String?;
  if (event != 'remote-lens') return null;

  Map<String, dynamic>? lensMap;
  if (msg['lens'] is Map) {
    lensMap = Map<String, dynamic>.from(msg['lens'] as Map);
  } else if (msg['payload'] is Map) {
    final payload = msg['payload'] as Map;
    lensMap = payload['lens'] is Map
        ? Map<String, dynamic>.from(payload['lens'] as Map)
        : Map<String, dynamic>.from(payload);
  }
  if (lensMap == null) return null;

  final mode = lensMap['mode'] as String?;
  switch (mode) {
    case 'admin':
      return AuthLens.admin;
    case 'anon':
      return AuthLens.anon;
    case 'app-session':
      return AuthLens.appSession;
    case 'as':
      return AuthLens.asUser(
        uid: lensMap['uid'] as String? ?? '',
        tenant: lensMap['tenant'] as String?,
        token: lensMap['token'] is Map
            ? Map<String, dynamic>.from(lensMap['token'] as Map)
            : null,
      );
    default:
      return null;
  }
}

/// Parsed wire error and whether it should be emitted on `denialStream`.
class ParsedBridgeError {
  final PyricBridgeException exception;
  final bool isDenial;

  const ParsedBridgeError({
    required this.exception,
    required this.isDenial,
  });
}

/// Decodes a wire error object from `worker-res` or `worker-snap` `__error`.
ParsedBridgeError parseBridgeError(
  Map<String, dynamic> errorMap, {
  required String defaultCode,
  required String defaultMessage,
}) {
  final code = errorMap['code'] as String? ?? defaultCode;
  final message = errorMap['message'] as String? ?? defaultMessage;
  final denialContext = errorMap['denialContext'];
  dynamic envelope = errorMap['aiEnvelope'];
  envelope ??= errorMap['envelope'];

  final exception = PyricBridgeException(
    code: code,
    message: message,
    denialContext: denialContext,
    envelope: envelope,
  );
  final lowerCode = code.toLowerCase();
  final isStorageDenial =
      lowerCode == 'storage/unauthorized' || lowerCode == 'unauthorized';
  final isDenial = denialContext != null ||
      lowerCode.contains('permission') ||
      isStorageDenial ||
      message.toLowerCase().contains('permission_denied');
  return ParsedBridgeError(exception: exception, isDenial: isDenial);
}
