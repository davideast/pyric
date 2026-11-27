import 'functions_http_transport.dart';

/// Web stub for [DartIoFunctionsHttpTransport] when `dart:io` is unavailable.
class DartIoFunctionsHttpTransport implements FunctionsHttpTransport {
  DartIoFunctionsHttpTransport({Object? httpClient});

  @override
  Future<FunctionsHttpResponse> postJson({
    required Uri uri,
    required Map<String, String> headers,
    required String body,
    Future<void>? abortSignal,
  }) {
    throw UnsupportedError(
      'DartIoFunctionsHttpTransport requires dart:io; provide a custom FunctionsHttpTransport on Web.',
    );
  }

  @override
  Future<FunctionsSseStreamResponse> postSse({
    required Uri uri,
    required Map<String, String> headers,
    required String body,
  }) {
    throw UnsupportedError(
      'DartIoFunctionsHttpTransport requires dart:io; provide a custom FunctionsHttpTransport on Web.',
    );
  }

  @override
  void close() {}
}
