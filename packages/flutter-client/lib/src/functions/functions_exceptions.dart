import 'package:firebase_core/firebase_core.dart';

import 'functions_serializer.dart';

/// Exception thrown by [FirebaseFunctions] callable invocations.
class FirebaseFunctionsException extends FirebaseException
    implements Exception {
  /// Optional structured details returned by the callable function's `HttpsError`.
  final dynamic details;

  /// Creates a [FirebaseFunctionsException] with the given [code], [message], and optional [details].
  FirebaseFunctionsException({
    required String message,
    required super.code,
    super.stackTrace,
    this.details,
  }) : super(
          plugin: 'firebase_functions',
          message: message,
        );

  @override
  String toString() {
    return '[firebase_functions/$code] ${message ?? code}';
  }
}

/// Canonical mapping from wire gRPC/HTTP status names to Firebase Functions error codes.
const Map<String, String> functionsErrorCodeMap = <String, String>{
  'OK': 'ok',
  'CANCELLED': 'cancelled',
  'UNKNOWN': 'unknown',
  'INVALID_ARGUMENT': 'invalid-argument',
  'DEADLINE_EXCEEDED': 'deadline-exceeded',
  'NOT_FOUND': 'not-found',
  'ALREADY_EXISTS': 'already-exists',
  'PERMISSION_DENIED': 'permission-denied',
  'UNAUTHENTICATED': 'unauthenticated',
  'RESOURCE_EXHAUSTED': 'resource-exhausted',
  'FAILED_PRECONDITION': 'failed-precondition',
  'ABORTED': 'aborted',
  'OUT_OF_RANGE': 'out-of-range',
  'UNIMPLEMENTED': 'unimplemented',
  'INTERNAL': 'internal',
  'UNAVAILABLE': 'unavailable',
  'DATA_LOSS': 'data-loss',
};

/// Maps an HTTP status code to a fallback Firebase Functions error code.
String codeForHttpStatus(int status) {
  if (status >= 200 && status < 300) {
    return 'ok';
  }
  switch (status) {
    case 0:
      return 'internal';
    case 400:
      return 'invalid-argument';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'permission-denied';
    case 404:
      return 'not-found';
    case 409:
      return 'aborted';
    case 429:
      return 'resource-exhausted';
    case 499:
      return 'cancelled';
    case 500:
      return 'internal';
    case 501:
      return 'unimplemented';
    case 503:
      return 'unavailable';
    case 504:
      return 'deadline-exceeded';
    default:
      return 'unknown';
  }
}

/// Builds a [FirebaseFunctionsException] from an HTTP status and decoded JSON body,
/// or returns `null` when the response represents a non-error `ok` status.
FirebaseFunctionsException? errorForCallableResponse(
  int httpStatus,
  Object? bodyJson, {
  String? url,
}) {
  final defaultCode = codeForHttpStatus(httpStatus);
  String code = defaultCode;
  String description = code;
  Object? details;

  if (bodyJson is Map) {
    final rawError = bodyJson['error'];
    if (rawError is Map) {
      final rawStatus = rawError['status'];
      if (rawStatus is String) {
        final mapped = functionsErrorCodeMap[rawStatus];
        if (mapped == null) {
          return FirebaseFunctionsException(
            code: 'internal',
            message: 'internal',
          );
        }
        if (mapped != 'ok' || defaultCode == 'ok') {
          code = mapped;
          description = rawStatus;
        }
      }

      final rawMessage = rawError['message'];
      if (rawMessage is String && rawMessage.isNotEmpty) {
        description = rawMessage;
      }

      if (rawError.containsKey('details')) {
        try {
          details = decodeCallableData(rawError['details']);
        } on FormatException catch (error) {
          return FirebaseFunctionsException(
            code: 'internal',
            message: 'Response error details could not be decoded: ${error.message}',
          );
        }
      }
    }
  }

  if (code == 'ok') {
    return null;
  }

  if (httpStatus == 404 && description == 'not-found' && url != null) {
    description = 'Callable target not found at $url (HTTP 404)';
  }

  return FirebaseFunctionsException(
    code: code,
    message: description,
    details: details,
  );
}
