import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'functions_http_transport.dart';

/// Default pure-Dart [FunctionsHttpTransport] backed by `dart:io` [HttpClient].
class DartIoFunctionsHttpTransport implements FunctionsHttpTransport {
  final HttpClient _client;
  final bool _ownsClient;
  bool _closed = false;

  DartIoFunctionsHttpTransport({HttpClient? httpClient})
      : _client = httpClient ?? (HttpClient()..autoUncompress = true),
        _ownsClient = httpClient == null;

  @override
  Future<FunctionsHttpResponse> postJson({
    required Uri uri,
    required Map<String, String> headers,
    required String body,
  }) async {
    if (_closed) {
      return const FunctionsHttpResponse(statusCode: 0, body: '');
    }
    try {
      final request = await _client.postUrl(uri);
      headers.forEach((name, value) {
        request.headers.set(name, value, preserveHeaderCase: true);
      });
      final payloadBytes = utf8.encode(body);
      request.contentLength = payloadBytes.length;
      request.add(payloadBytes);
      final response = await request.close();
      final text = await response.transform(utf8.decoder).join();
      return FunctionsHttpResponse(
        statusCode: response.statusCode,
        body: text,
      );
    } catch (_) {
      return const FunctionsHttpResponse(statusCode: 0, body: '');
    }
  }

  @override
  Future<FunctionsSseStreamResponse> postSse({
    required Uri uri,
    required Map<String, String> headers,
    required String body,
  }) async {
    if (_closed) {
      return const FunctionsSseStreamResponse(
        statusCode: 0,
        byteStream: Stream<List<int>>.empty(),
      );
    }
    try {
      final request = await _client.postUrl(uri);
      headers.forEach((name, value) {
        request.headers.set(name, value, preserveHeaderCase: true);
      });
      final payloadBytes = utf8.encode(body);
      request.contentLength = payloadBytes.length;
      request.add(payloadBytes);
      final response = await request.close();
      return FunctionsSseStreamResponse(
        statusCode: response.statusCode,
        byteStream: response,
      );
    } catch (_) {
      return const FunctionsSseStreamResponse(
        statusCode: 0,
        byteStream: Stream<List<int>>.empty(),
      );
    }
  }

  @override
  void close() {
    if (_closed) {
      return;
    }
    _closed = true;
    if (_ownsClient) {
      _client.close(force: true);
    }
  }
}
