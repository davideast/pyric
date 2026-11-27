import 'dart:async';

export 'functions_http_transport_stub.dart'
    if (dart.library.io) 'functions_http_transport_io.dart'
    show DartIoFunctionsHttpTransport;

/// Decoded HTTP status and text body from a non-streaming callable POST.
class FunctionsHttpResponse {
  final int statusCode;
  final String body;

  const FunctionsHttpResponse({
    required this.statusCode,
    required this.body,
  });
}

/// Streaming HTTP response carrying status code and raw byte chunks for SSE.
class FunctionsSseStreamResponse {
  final int statusCode;
  final Stream<List<int>> byteStream;

  const FunctionsSseStreamResponse({
    required this.statusCode,
    required this.byteStream,
  });
}

/// Pluggable HTTP transport boundary for [FirebaseFunctions] callable invocations.
abstract interface class FunctionsHttpTransport {
  /// Sends a `POST` request and buffers the response body.
  Future<FunctionsHttpResponse> postJson({
    required Uri uri,
    required Map<String, String> headers,
    required String body,
  });

  /// Sends a `POST` request and exposes the raw response byte stream for SSE consumption.
  Future<FunctionsSseStreamResponse> postSse({
    required Uri uri,
    required Map<String, String> headers,
    required String body,
  });

  /// Releases any underlying socket resources.
  void close();
}
