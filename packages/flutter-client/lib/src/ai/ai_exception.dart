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
    super.wireStatus = 'INVALID_ARGUMENT',
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
    super.wireStatus = 'FAILED_PRECONDITION',
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

String _stripServicePrefix(String rawToken) {
  final cleaned = rawToken.trim();
  final slashIndex = cleaned.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= cleaned.length - 1) {
    return cleaned;
  }
  final prefix = cleaned.substring(0, slashIndex).toLowerCase();
  if (prefix == 'ai' ||
      prefix == 'firebase_ai' ||
      prefix == 'firebase-ai' ||
      prefix == 'appcheck' ||
      prefix == 'app-check' ||
      prefix == 'app_check') {
    return cleaned.substring(slashIndex + 1);
  }
  return cleaned;
}

_MappedStatus _mapStatusToken(String rawToken, {int? explicitHttpCode}) {
  final stripped = _stripServicePrefix(rawToken);
  final upper = stripped.toUpperCase().replaceAll('-', '_');

  switch (upper) {
    case 'INVALID_ARGUMENT':
    case 'FAILED_PRECONDITION':
    case 'OUT_OF_RANGE':
      final rpc = (upper == 'FAILED_PRECONDITION' || upper == 'OUT_OF_RANGE')
          ? upper
          : 'INVALID_ARGUMENT';
      return _MappedStatus('invalid-argument', explicitHttpCode ?? 400, rpc);
    case 'UNAUTHENTICATED':
      return _MappedStatus('unauthenticated', explicitHttpCode ?? 401, upper);
    case 'PERMISSION_DENIED':
      return _MappedStatus('permission-denied', explicitHttpCode ?? 403, upper);
    case 'NOT_FOUND':
      return _MappedStatus('not-found', explicitHttpCode ?? 404, upper);
    case 'ALREADY_EXISTS':
    case 'ABORTED':
      return _MappedStatus('aborted', explicitHttpCode ?? 409, upper);
    case 'RESOURCE_EXHAUSTED':
    case 'QUOTA_EXCEEDED':
      return _MappedStatus(
        'quota-exceeded',
        explicitHttpCode ?? 429,
        'RESOURCE_EXHAUSTED',
      );
    case 'CANCELLED':
    case 'CANCELED':
      return _MappedStatus('cancelled', explicitHttpCode ?? 499, 'CANCELLED');
    case 'UNAVAILABLE':
      return _MappedStatus('unavailable', explicitHttpCode ?? 503, upper);
    case 'DEADLINE_EXCEEDED':
      return _MappedStatus('deadline-exceeded', explicitHttpCode ?? 504, upper);
    case 'INTERNAL':
    case 'DATA_LOSS':
      return _MappedStatus('internal', explicitHttpCode ?? 500, upper);
    case 'UNIMPLEMENTED':
    case 'UNSUPPORTED':
      return _MappedStatus(
        'unsupported',
        explicitHttpCode ?? 501,
        'UNIMPLEMENTED',
      );
    default:
      return _mapFallbackHttpStatus(stripped, explicitHttpCode);
  }
}

_MappedStatus _mapFallbackHttpStatus(String stripped, int? explicitHttpCode) {
  if (explicitHttpCode != null) {
    switch (explicitHttpCode) {
      case 400:
        return const _MappedStatus('invalid-argument', 400, 'INVALID_ARGUMENT');
      case 401:
        return const _MappedStatus('unauthenticated', 401, 'UNAUTHENTICATED');
      case 403:
        return const _MappedStatus(
          'permission-denied',
          403,
          'PERMISSION_DENIED',
        );
      case 404:
        return const _MappedStatus('not-found', 404, 'NOT_FOUND');
      case 429:
        return const _MappedStatus(
          'quota-exceeded',
          429,
          'RESOURCE_EXHAUSTED',
        );
      case 500:
        return const _MappedStatus('internal', 500, 'INTERNAL');
      case 503:
        return const _MappedStatus('unavailable', 503, 'UNAVAILABLE');
      case 504:
        return const _MappedStatus(
          'deadline-exceeded',
          504,
          'DEADLINE_EXCEEDED',
        );
    }
  }
  final normalized = stripped.isEmpty
      ? 'unknown'
      : stripped.toLowerCase().replaceAll('_', '-');
  return _MappedStatus(normalized, explicitHttpCode, null);
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

List<Map<String, dynamic>>? _extractErrorDetails(
  Map<String, dynamic>? envelope,
) {
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

Set<String> _extractReasonCodes(List<Map<String, dynamic>>? details) {
  if (details == null || details.isEmpty) {
    return const <String>{};
  }
  final reasons = <String>{};
  for (final detail in details) {
    final reason = detail['reason'];
    if (reason is String && reason.isNotEmpty) {
      reasons.add(reason.toUpperCase());
    }
  }
  return reasons;
}

bool _isInvalidApiKeyError(
  Set<String> reasons,
  String message,
  String mappedCode,
) {
  if (reasons.contains('API_KEY_INVALID')) {
    return true;
  }
  final lower = message.toLowerCase();
  return (mappedCode == 'invalid-argument' ||
          mappedCode == 'permission-denied' ||
          mappedCode == 'unauthenticated') &&
      (lower.contains('api key not valid') ||
          lower.contains('api_key_invalid') ||
          lower.contains('invalid api key'));
}

bool _isApiNotEnabledError(
  Set<String> reasons,
  String message,
  String mappedCode,
) {
  if (reasons.contains('SERVICE_DISABLED') ||
      reasons.contains('API_NOT_ENABLED')) {
    return true;
  }
  final lower = message.toLowerCase();
  return mappedCode == 'permission-denied' &&
      (lower.contains('has not been used in project') ||
          lower.contains('api is disabled') ||
          lower.contains('service_disabled') ||
          lower.contains('api has not been enabled'));
}

bool _isUnsupportedLocationError(
  Set<String> reasons,
  String message,
  String? rpcStatus,
) {
  if (reasons.contains('USER_LOCATION_NOT_SUPPORTED')) {
    return true;
  }
  return (rpcStatus == 'FAILED_PRECONDITION' ||
          rpcStatus == 'INVALID_ARGUMENT' ||
          rpcStatus == 'PERMISSION_DENIED') &&
      message.toLowerCase().contains('user location is not supported');
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
    final resolvedMessage =
        (envelopeMessage != null && envelopeMessage.isNotEmpty)
            ? envelopeMessage
            : error.message;

    if (envelope == null &&
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
    final reasons = _extractReasonCodes(details);

    if (_isInvalidApiKeyError(reasons, resolvedMessage, mapped.code)) {
      return InvalidApiKey(
        resolvedMessage,
        code: 'invalid-argument',
        httpStatusCode: mapped.httpStatus ?? 400,
        wireStatus: mapped.rpcStatus ?? 'INVALID_ARGUMENT',
        wireEnvelope: envelope,
        errorDetails: details,
      );
    }
    if (_isApiNotEnabledError(reasons, resolvedMessage, mapped.code)) {
      return ServiceApiNotEnabled(
        resolvedMessage,
        code: 'permission-denied',
        httpStatusCode: mapped.httpStatus ?? 403,
        wireStatus: mapped.rpcStatus ?? 'PERMISSION_DENIED',
        wireEnvelope: envelope,
        errorDetails: details,
      );
    }
    if (_isUnsupportedLocationError(
      reasons,
      resolvedMessage,
      mapped.rpcStatus,
    )) {
      return UnsupportedUserLocation(
        resolvedMessage,
        code: 'invalid-argument',
        httpStatusCode: mapped.httpStatus ?? 400,
        wireStatus: mapped.rpcStatus ?? 'FAILED_PRECONDITION',
        wireEnvelope: envelope,
        errorDetails: details,
      );
    }
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
