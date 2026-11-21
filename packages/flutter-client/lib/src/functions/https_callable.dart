import 'dart:async';
import 'dart:convert';

import 'functions_exceptions.dart';
import 'functions_http_transport.dart';
import 'functions_serializer.dart';
import 'functions_url.dart';

/// Default callable request deadline (70 seconds), matching Firebase Functions SDKs.
const Duration defaultCallableTimeout = Duration(seconds: 70);

/// Configuration options for an [HttpsCallable] reference.
class HttpsCallableOptions {
  /// Maximum duration before a non-streaming `call()` rejects with `deadline-exceeded`.
  final Duration timeout;

  /// Whether to attach a single-use App Check token via `getLimitedUseToken()`.
  final bool limitedUseAppCheckToken;

  /// Creates [HttpsCallableOptions].
  ///
  /// Accepts [limitedUseAppCheckToken] (FlutterFire convention) as well as optional
  /// [limitedUseAppCheckTokens] alias for cross-SDK parity.
  const HttpsCallableOptions({
    this.timeout = defaultCallableTimeout,
    bool limitedUseAppCheckToken = false,
    bool? limitedUseAppCheckTokens,
  }) : limitedUseAppCheckToken =
            limitedUseAppCheckTokens ?? limitedUseAppCheckToken;

  /// Cross-SDK getter alias for [limitedUseAppCheckToken].
  bool get limitedUseAppCheckTokens => limitedUseAppCheckToken;
}

/// Decoded result envelope returned by [HttpsCallable.call] and terminal [Result] frames.
class HttpsCallableResult<T> {
  final T _data;

  /// Creates an [HttpsCallableResult] wrapping decoded [data].
  const HttpsCallableResult(this._data);

  /// Decoded response payload returned by the callable function.
  T get data => _data;
}

/// Sealed event emitted by [HttpsCallable.stream].
sealed class StreamResponse<T, R> {
  const StreamResponse();
}

/// Incremental partial chunk emitted by a streaming callable (`response.sendChunk(...)`).
final class Chunk<T, R> extends StreamResponse<T, R> {
  /// Decoded chunk payload.
  final T partialData;

  /// Creates a [Chunk] event carrying [partialData].
  const Chunk(this.partialData);
}

/// Terminal result emitted when a streaming callable returns its final value.
final class Result<T, R> extends StreamResponse<T, R> {
  /// Final callable result wrapper.
  final HttpsCallableResult<R> result;

  /// Creates a [Result] event carrying [result].
  const Result(this.result);
}

/// Internal context supplied by [FirebaseFunctions] to execute callable requests.
class CallableExecutionContext {
  final ResolvedCallableTarget Function() resolveTarget;
  final Future<Map<String, String>> Function({required bool limitedUse})
      buildHeaders;
  final FunctionsHttpTransport Function() getTransport;
  final bool Function() isDisposed;
  final Future<void> Function() cancelSignal;

  const CallableExecutionContext({
    required this.resolveTarget,
    required this.buildHeaders,
    required this.getTransport,
    required this.isDisposed,
    required this.cancelSignal,
  });
}

/// Reference to an HTTP `onCall` Cloud Function supporting `call()` and `stream()`.
class HttpsCallable {
  final CallableExecutionContext _context;

  /// Options configured on this callable handle.
  final HttpsCallableOptions options;

  /// Creates an [HttpsCallable] bound to an execution context and [options].
  HttpsCallable.internal({
    required CallableExecutionContext context,
    HttpsCallableOptions? options,
  })  : _context = context,
        options = options ?? const HttpsCallableOptions();

  /// Configured timeout for non-streaming [call] invocations.
  Duration get timeout => options.timeout;

  /// Returns a copy of this [HttpsCallable] with an updated [timeout].
  HttpsCallable withTimeout(Duration timeout) {
    return HttpsCallable.internal(
      context: _context,
      options: HttpsCallableOptions(
        timeout: timeout,
        limitedUseAppCheckToken: options.limitedUseAppCheckToken,
      ),
    );
  }

  /// Invokes the callable function with optional [parameters] and decodes the result.
  ///
  /// Because this method is named `call`, an [HttpsCallable] instance can also be
  /// invoked directly as a function (`await callable(params)`).
  Future<HttpsCallableResult<T>> call<T>([dynamic parameters]) async {
    final encodedData = encodeCallableData(parameters);
    if (_context.isDisposed()) {
      throw FirebaseFunctionsException(
        code: 'cancelled',
        message: 'Firebase Functions instance was deleted.',
      );
    }

    final target = _context.resolveTarget();
    final authHeaders = await _context.buildHeaders(
      limitedUse: options.limitedUseAppCheckToken,
    );
    final requestHeaders = <String, String>{
      ...authHeaders,
      'Content-Type': 'application/json',
    };
    final requestBody = jsonEncode(<String, Object?>{'data': encodedData});

    final effectiveTimeout = options.timeout > Duration.zero
        ? options.timeout
        : defaultCallableTimeout;
    final completer = Completer<FunctionsHttpResponse>();
    final timer = Timer(effectiveTimeout, () {
      if (!completer.isCompleted) {
        completer.completeError(
          FirebaseFunctionsException(
            code: 'deadline-exceeded',
            message: 'deadline-exceeded',
          ),
        );
      }
    });

    unawaited(
      _context.cancelSignal().then((_) {
        if (!completer.isCompleted) {
          completer.completeError(
            FirebaseFunctionsException(
              code: 'cancelled',
              message: 'Firebase Functions instance was deleted.',
            ),
          );
        }
      }),
    );

    unawaited(
      _context
          .getTransport()
          .postJson(
            uri: target.uri,
            headers: requestHeaders,
            body: requestBody,
          )
          .then(
        (res) {
          if (!completer.isCompleted) {
            completer.complete(res);
          }
        },
        onError: (Object error, StackTrace stackTrace) {
          if (!completer.isCompleted) {
            completer.complete(
              const FunctionsHttpResponse(statusCode: 0, body: ''),
            );
          }
        },
      ),
    );

    FunctionsHttpResponse response;
    try {
      response = await completer.future;
    } finally {
      timer.cancel();
    }

    Map<String, dynamic>? parsedObject;
    if (response.body.isNotEmpty) {
      try {
        final decodedJson = jsonDecode(response.body);
        if (decodedJson is Map) {
          parsedObject = Map<String, dynamic>.from(decodedJson);
        }
      } on FormatException {
        parsedObject = null;
      }
    }

    final responseError = errorForCallableResponse(
      response.statusCode,
      parsedObject,
      url: target.uri.toString(),
    );
    if (responseError != null) {
      throw responseError;
    }

    if (parsedObject == null) {
      throw FirebaseFunctionsException(
        code: 'internal',
        message: 'Response is not valid JSON object.',
      );
    }

    final bool hasDataKey = parsedObject.containsKey('data');
    final bool hasResultKey = parsedObject.containsKey('result');
    if (!hasDataKey && !hasResultKey) {
      throw FirebaseFunctionsException(
        code: 'internal',
        message: 'Response is missing data field.',
      );
    }

    final Object? rawResult =
        hasDataKey ? parsedObject['data'] : parsedObject['result'];
    try {
      final decodedResult = decodeCallableData(rawResult);
      return HttpsCallableResult<T>(decodedResult as T);
    } on FormatException catch (error) {
      throw FirebaseFunctionsException(
        code: 'internal',
        message: 'Response payload could not be decoded: ${error.message}',
      );
    }
  }

  /// Invokes the callable function in SSE streaming mode (`Accept: text/event-stream`),
  /// yielding [Chunk] events for incremental messages and a terminal [Result] event.
  Stream<StreamResponse<T, R>> stream<T, R>([dynamic parameters]) {
    late final StreamController<StreamResponse<T, R>> controller;
    StreamSubscription<String>? sseSub;
    var cancelled = false;

    void emitErrorAndClose(FirebaseFunctionsException error) {
      if (cancelled || controller.isClosed) {
        return;
      }
      controller.addError(error);
      unawaited(controller.close());
    }

    void processSseLine(String rawLine, String url) {
      if (cancelled || controller.isClosed) {
        return;
      }
      final line = rawLine.trim();
      if (!line.startsWith('data:')) {
        return;
      }
      final payload = line.substring('data:'.length).trimLeft();
      if (payload.isEmpty) {
        return;
      }

      Object? parsed;
      try {
        parsed = jsonDecode(payload);
      } on FormatException {
        return;
      }
      if (parsed is! Map) {
        return;
      }
      final jsonMap = Map<String, dynamic>.from(parsed);

      if (jsonMap.containsKey('error')) {
        final mapped = errorForCallableResponse(0, jsonMap, url: url) ??
            FirebaseFunctionsException(code: 'internal', message: 'internal');
        unawaited(sseSub?.cancel());
        emitErrorAndClose(mapped);
        return;
      }

      if (jsonMap.containsKey('message')) {
        try {
          final chunkVal = decodeCallableData(jsonMap['message']);
          controller.add(Chunk<T, R>(chunkVal as T));
        } catch (error) {
          unawaited(sseSub?.cancel());
          emitErrorAndClose(
            FirebaseFunctionsException(
              code: 'internal',
              message: 'Failed to decode stream chunk: $error',
            ),
          );
        }
        return;
      }

      if (jsonMap.containsKey('result')) {
        try {
          final finalVal = decodeCallableData(jsonMap['result']);
          controller.add(Result<T, R>(HttpsCallableResult<R>(finalVal as R)));
          unawaited(sseSub?.cancel());
          unawaited(controller.close());
        } catch (error) {
          unawaited(sseSub?.cancel());
          emitErrorAndClose(
            FirebaseFunctionsException(
              code: 'internal',
              message: 'Failed to decode stream result: $error',
            ),
          );
        }
      }
    }

    Future<void> start() async {
      final Object? encodedData;
      try {
        encodedData = encodeCallableData(parameters);
      } catch (error, stackTrace) {
        if (!cancelled && !controller.isClosed) {
          controller.addError(error, stackTrace);
          await controller.close();
        }
        return;
      }

      if (_context.isDisposed()) {
        emitErrorAndClose(
          FirebaseFunctionsException(
            code: 'cancelled',
            message: 'Firebase Functions instance was deleted.',
          ),
        );
        return;
      }

      final ResolvedCallableTarget target;
      final Map<String, String> authHeaders;
      try {
        target = _context.resolveTarget();
        authHeaders = await _context.buildHeaders(
          limitedUse: options.limitedUseAppCheckToken,
        );
      } catch (error, stackTrace) {
        if (!cancelled && !controller.isClosed) {
          controller.addError(error, stackTrace);
          await controller.close();
        }
        return;
      }

      if (cancelled || controller.isClosed) {
        return;
      }

      final headers = <String, String>{
        ...authHeaders,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      };
      final requestBody = jsonEncode(<String, Object?>{'data': encodedData});
      final response = await _context.getTransport().postSse(
            uri: target.uri,
            headers: headers,
            body: requestBody,
          );

      if (cancelled || controller.isClosed) {
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        String errorText = '';
        try {
          errorText = await response.byteStream.transform(utf8.decoder).join();
        } catch (_) {
          errorText = '';
        }
        Map<String, dynamic>? errorJson;
        if (errorText.isNotEmpty) {
          try {
            final decoded = jsonDecode(errorText);
            if (decoded is Map) {
              errorJson = Map<String, dynamic>.from(decoded);
            }
          } on FormatException {
            errorJson = null;
          }
        }
        final mapped = errorForCallableResponse(
              response.statusCode,
              errorJson,
              url: target.uri.toString(),
            ) ??
            FirebaseFunctionsException(code: 'internal', message: 'internal');
        emitErrorAndClose(mapped);
        return;
      }

      var lineBuffer = '';
      final urlString = target.uri.toString();
      sseSub = response.byteStream.transform(utf8.decoder).listen(
        (chunk) {
          if (cancelled || controller.isClosed) {
            return;
          }
          lineBuffer += chunk;
          final parts = lineBuffer.split('\n');
          lineBuffer = parts.removeLast();
          for (final part in parts) {
            processSseLine(part, urlString);
            if (cancelled || controller.isClosed) {
              return;
            }
          }
        },
        onError: (Object error) {
          if (error is FirebaseFunctionsException) {
            emitErrorAndClose(error);
          } else {
            emitErrorAndClose(
              FirebaseFunctionsException(code: 'internal', message: 'internal'),
            );
          }
        },
        onDone: () {
          if (cancelled || controller.isClosed) {
            return;
          }
          if (lineBuffer.trim().isNotEmpty) {
            processSseLine(lineBuffer, urlString);
          }
          if (!controller.isClosed) {
            unawaited(controller.close());
          }
        },
        cancelOnError: true,
      );
    }

    controller = StreamController<StreamResponse<T, R>>(
      sync: true,
      onListen: () {
        unawaited(start());
      },
      onCancel: () async {
        cancelled = true;
        await sseSub?.cancel();
      },
    );

    return controller.stream;
  }
}
