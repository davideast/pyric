import 'package:firebase_core/firebase_core.dart' show FirebaseException;

import '../transport/exceptions.dart';

/// Base exception thrown when Firebase AI Logic operations fail.
class FirebaseAIException implements Exception {
  /// Human-readable description of the failure.
  final String message;

  /// Normalized kebab-case error code (for example `unauthenticated`,
  /// `permission-denied`, `invalid-argument`, `quota-exceeded`, `unavailable`).
  final String code;

  /// Numeric HTTP status code carried by a Gemini wire error envelope, if any.
  final int? httpStatusCode;

  /// Canonical Gemini RPC status string (for example `UNAUTHENTICATED`,
  /// `INVALID_ARGUMENT`, `RESOURCE_EXHAUSTED`), if available.
  final String? wireStatus;

  /// Preserved Gemini wire error envelope (`{ "error": { ... } }`), if available.
  final Map<String, dynamic>? wireEnvelope;

  /// Structured `error.details` entries from the wire envelope, if present.
  final List<Map<String, dynamic>>? errorDetails;

  const FirebaseAIException(
    this.message, {
    this.code = 'unknown',
    this.httpStatusCode,
    this.wireStatus,
    this.wireEnvelope,
    this.errorDetails,
  });

  /// Alias for [httpStatusCode] matching HTTP response status conventions.
  int? get status => httpStatusCode;

  @override
  String toString() => 'FirebaseAIException($code): $message';
}

/// Thrown when the configured API key is rejected by the backend.
final class InvalidApiKey extends FirebaseAIException {
  const InvalidApiKey(
    super.message, {
    super.code = 'invalid-api-key',
    super.httpStatusCode = 400,
    super.wireStatus,
    super.wireEnvelope,
    super.errorDetails,
  });
}

/// Thrown when the AI backend reports a server-side or transport failure.
final class ServerException extends FirebaseAIException {
  const ServerException(
    super.message, {
    super.code = 'server-error',
    super.httpStatusCode,
    super.wireStatus,
    super.wireEnvelope,
    super.errorDetails,
  });
}

/// Thrown when project or model quota has been exhausted (`429 RESOURCE_EXHAUSTED`).
final class QuotaExceeded extends FirebaseAIException {
  const QuotaExceeded(
    super.message, {
    super.code = 'quota-exceeded',
    super.httpStatusCode = 429,
    super.wireStatus = 'RESOURCE_EXHAUSTED',
    super.wireEnvelope,
    super.errorDetails,
  });
}

/// Thrown when the Firebase AI API is not enabled for the target project.
final class ServiceApiNotEnabled extends FirebaseAIException {
  const ServiceApiNotEnabled(
    super.message, {
    super.code = 'api-not-enabled',
    super.httpStatusCode = 403,
    super.wireStatus = 'PERMISSION_DENIED',
    super.wireEnvelope,
    super.errorDetails,
  });
}

/// Thrown when the client location is unsupported by the Gemini API.
final class UnsupportedUserLocation extends FirebaseAIException {
  const UnsupportedUserLocation(
    super.message, {
    super.code = 'unsupported-user-location',
    super.httpStatusCode = 400,
    super.wireStatus,
    super.wireEnvelope,
    super.errorDetails,
  });
}

/// Thrown when a Gemini request or response payload fails wire serialization.
final class SerializationException extends FirebaseAIException {
  const SerializationException(
    super.message, {
    super.code = 'parse-failed',
    super.httpStatusCode,
    super.wireStatus,
    super.wireEnvelope,
    super.errorDetails,
  });
}

class _MappedStatus {
  final String code;
  final int? httpStatus;
  final String? rpcStatus;

  const _MappedStatus(this.code, this.httpStatus, this.rpcStatus);
}

_MappedStatus _mapStatusToken(String rawToken, {int? explicitHttpCode}) {
  final cleaned = rawToken.trim();
  final stripped = cleaned.toLowerCase().startsWith('ai/')
      ? cleaned.substring(3)
      : cleaned;
  final upper = stripped.toUpperCase().replaceAll('-', '_');

  switch (upper) {
    case 'INVALID_ARGUMENT':
    case 'FAILED_PRECONDITION':
    case 'OUT_OF_RANGE':
      return _MappedStatus('invalid-argument', explicitHttpCode ?? 400, upper);
    case 'UNAUTHENTICATED':
      return _MappedStatus('unauthenticated', explicitHttpCode ?? 401, upper);
    case 'PERMISSION_DENIED':
      return _MappedStatus('permission-denied', explicitHttpCode ?? 403, upper);
    case 'NOT_FOUND':
      return _MappedStatus('not-found', explicitHttpCode ?? 404, upper);
    case 'RESOURCE_EXHAUSTED':
    case 'QUOTA_EXCEEDED':
      return _MappedStatus(
        'quota-exceeded',
        explicitHttpCode ?? 429,
        'RESOURCE_EXHAUSTED',
      );
    case 'UNAVAILABLE':
      return _MappedStatus('unavailable', explicitHttpCode ?? 503, upper);
    case 'DEADLINE_EXCEEDED':
      return _MappedStatus('deadline-exceeded', explicitHttpCode ?? 504, upper);
    case 'INTERNAL':
      return _MappedStatus('internal', explicitHttpCode ?? 500, upper);
    case 'UNIMPLEMENTED':
      return _MappedStatus('unsupported', explicitHttpCode ?? 501, upper);
    default:
      final normalized = stripped.isEmpty
          ? 'unknown'
          : stripped.toLowerCase().replaceAll('_', '-');
      return _MappedStatus(normalized, explicitHttpCode, null);
  }
}

Map<String, dynamic>? _extractWireEnvelope(dynamic rawEnvelope) {
  if (rawEnvelope is! Map) {
    return null;
  }
  final map = Map<String, dynamic>.from(rawEnvelope);
  if (map['error'] is Map) {
    return <String, dynamic>{
      'error': Map<String, dynamic>.from(map['error'] as Map),
    };
  }
  if (map['aiEnvelope'] is Map) {
    final nested = Map<String, dynamic>.from(map['aiEnvelope'] as Map);
    if (nested['error'] is Map) {
      return <String, dynamic>{
        'error': Map<String, dynamic>.from(nested['error'] as Map),
      };
    }
  }
  return null;
}

List<Map<String, dynamic>>? _extractErrorDetails(Map<String, dynamic>? envelope) {
  final errorObj = envelope?['error'];
  if (errorObj is! Map) {
    return null;
  }
  final rawDetails = errorObj['details'];
  if (rawDetails is! List) {
    return null;
  }
  return List<Map<String, dynamic>>.unmodifiable(
    rawDetails
        .whereType<Map>()
        .map((entry) => Map<String, dynamic>.from(entry)),
  );
}

/// Translates bridge, App Check, or codec failures into [FirebaseAIException].
FirebaseAIException mapBridgeErrorToFirebaseAIException(Object error) {
  if (error is FirebaseAIException) {
    return error;
  }

  if (error is PyricBridgeException) {
    var envelope = _extractWireEnvelope(error.envelope);
    final errorObj = envelope?['error'] as Map<String, dynamic>?;
    final envelopeHttpCode = (errorObj?['code'] as num?)?.toInt();
    final envelopeStatus = errorObj?['status'] as String?;
    final envelopeMessage = errorObj?['message'] as String?;

    final statusSource = envelopeStatus ?? error.code;
    final mapped = _mapStatusToken(
      statusSource,
      explicitHttpCode: envelopeHttpCode,
    );
    final resolvedMessage = (envelopeMessage != null && envelopeMessage.isNotEmpty)
        ? envelopeMessage
        : error.message;

    if (envelope == null &&
        (error.code.toLowerCase().startsWith('ai/') || mapped.rpcStatus != null) &&
        mapped.httpStatus != null &&
        mapped.rpcStatus != null) {
      envelope = <String, dynamic>{
        'error': <String, dynamic>{
          'code': mapped.httpStatus,
          'message': resolvedMessage,
          'status': mapped.rpcStatus,
        },
      };
    }
    final details = _extractErrorDetails(envelope);

    if (mapped.code == 'quota-exceeded') {
      return QuotaExceeded(
        resolvedMessage,
        code: mapped.code,
        httpStatusCode: mapped.httpStatus ?? 429,
        wireStatus: mapped.rpcStatus ?? 'RESOURCE_EXHAUSTED',
        wireEnvelope: envelope,
        errorDetails: details,
      );
    }
    if (mapped.code == 'unavailable' ||
        mapped.code == 'deadline-exceeded' ||
        mapped.code == 'internal') {
      return ServerException(
        resolvedMessage,
        code: mapped.code,
        httpStatusCode: mapped.httpStatus,
        wireStatus: mapped.rpcStatus,
        wireEnvelope: envelope,
        errorDetails: details,
      );
    }
    return FirebaseAIException(
      resolvedMessage,
      code: mapped.code,
      httpStatusCode: mapped.httpStatus,
      wireStatus: mapped.rpcStatus,
      wireEnvelope: envelope,
      errorDetails: details,
    );
  }

  if (error is FirebaseException) {
    final mapped = _mapStatusToken(error.code);
    return FirebaseAIException(
      error.message ?? error.toString(),
      code: mapped.code,
      httpStatusCode: mapped.httpStatus,
      wireStatus: mapped.rpcStatus,
    );
  }

  return FirebaseAIException(error.toString());
}
