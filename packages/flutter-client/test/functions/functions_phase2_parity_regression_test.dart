import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_firestore.dart'
    hide AuthLens, PyricAuthCredentialsProvider;
import 'package:pyric_firestore/pyric_functions.dart';

import '../auth/mock_bridge_helper.dart';

class _StubSseTransport implements FunctionsHttpTransport {
  final Future<FunctionsSseStreamResponse> Function() onPostSse;
  _StubSseTransport(this.onPostSse);

  @override
  Future<FunctionsHttpResponse> postJson({
    required Uri uri,
    required Map<String, String> headers,
    required String body,
  }) async =>
      const FunctionsHttpResponse(statusCode: 200, body: '{"data":"ok"}');

  @override
  Future<FunctionsSseStreamResponse> postSse({
    required Uri uri,
    required Map<String, String> headers,
    required String body,
  }) =>
      onPostSse();

  @override
  void close() {}
}

void main() {
  test('P2-F07: BigInt UInt64Value tagging, strict 64-bit decode, and non-2xx OK guard', () {
    final maxInt64 = BigInt.parse('9223372036854775807');
    final minInt64 = BigInt.parse('-9223372036854775808');
    final maxUint64 = BigInt.parse('18446744073709551615');

    expect(encodeCallableData(maxInt64), {
      '@type': int64TypeUrl,
      'value': '9223372036854775807',
    });
    expect(encodeCallableData(maxUint64), {
      '@type': uint64TypeUrl,
      'value': '18446744073709551615',
    });
    expect(() => encodeCallableData(minInt64 - BigInt.one), throwsArgumentError);
    expect(() => encodeCallableData(maxUint64 + BigInt.one), throwsArgumentError);

    expect(
      decodeCallableData({'@type': uint64TypeUrl, 'value': '18446744073709551615'}),
      maxUint64,
    );
    expect(
      () => decodeCallableData({'@type': int64TypeUrl, 'value': '1.5'}),
      throwsFormatException,
    );
    expect(
      () => decodeCallableData({'@type': int64TypeUrl, 'value': '9223372036854775808'}),
      throwsFormatException,
    );
    expect(
      () => decodeCallableData({'@type': uint64TypeUrl, 'value': '-1'}),
      throwsFormatException,
    );

    final err500 = errorForCallableResponse(500, {
      'error': {'status': 'OK', 'message': 'spoofed ok'},
      'data': 'ok',
    });
    expect(err500, isNotNull);
    expect(err500!.code, 'internal');
  });

  test('P2-F06a/b/c: stream honors dispose cancelSignal, maps postSse UnsupportedError, and drains byteStream on early cancel', () async {
    final unsupportedFn = FirebaseFunctions(
      projectId: 'p2-fn',
      gatewayOrigin: 'http://127.0.0.1:5174',
      transport: _StubSseTransport(() => throw UnsupportedError('no dart:io')),
    );
    await expectLater(
      unsupportedFn.httpsCallable('demo').stream<Object?, Object?>(),
      emitsError(isA<FirebaseFunctionsException>().having((e) => e.code, 'code', 'unimplemented')),
    );

    final ssePending = Completer<FunctionsSseStreamResponse>();
    var byteStreamCancelled = false;
    final byteController = StreamController<List<int>>(
      onCancel: () {
        byteStreamCancelled = true;
      },
    );
    final cancelFn = FirebaseFunctions(
      projectId: 'p2-fn',
      gatewayOrigin: 'http://127.0.0.1:5174',
      transport: _StubSseTransport(() => ssePending.future),
    );
    final sub = cancelFn.httpsCallable('demo').stream<Object?, Object?>().listen((_) {});
    await pumpEventQueue();
    await sub.cancel();
    ssePending.complete(
      FunctionsSseStreamResponse(statusCode: 200, byteStream: byteController.stream),
    );
    await pumpEventQueue();
    expect(byteStreamCancelled, isTrue);

    final hangingByteController = StreamController<List<int>>();
    final disposeFn = FirebaseFunctions(
      projectId: 'p2-fn',
      gatewayOrigin: 'http://127.0.0.1:5174',
      transport: _StubSseTransport(
        () async => FunctionsSseStreamResponse(
          statusCode: 200,
          byteStream: hangingByteController.stream,
        ),
      ),
    );
    final streamErrors = <Object>[];
    final disposeSub = disposeFn
        .httpsCallable('demo')
        .stream<Object?, Object?>()
        .listen((_) {}, onError: streamErrors.add);
    await pumpEventQueue();
    disposeFn.dispose();
    await pumpEventQueue();
    expect(streamErrors.length, 1);
    expect((streamErrors.first as FirebaseFunctionsException).code, 'cancelled');
    await disposeSub.cancel();
    await hangingByteController.close();
  });

  test('P2-F06d: DartIoFunctionsHttpTransport preserves HTTP 503 on invalid UTF-8 body and aborts on timeout', () async {
    final prevOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      req.response.statusCode = 503;
      req.response.add([0xFF, 0xFE, 0xFD]);
      await req.response.close();
    });
    final slowServer = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final socketClosed = Completer<void>();
    slowServer.listen((socket) {
      socket.listen(
        (_) {},
        onError: (_) {
          if (!socketClosed.isCompleted) socketClosed.complete();
        },
        onDone: () {
          if (!socketClosed.isCompleted) socketClosed.complete();
        },
      );
    });
    try {
      final fn = FirebaseFunctions(
        projectId: 'p2-fn',
        gatewayOrigin: 'http://127.0.0.1:${server.port}',
      );
      await expectLater(
        fn.httpsCallable('badUtf8').call<Object?>(),
        throwsA(isA<FirebaseFunctionsException>().having((e) => e.code, 'code', 'unavailable')),
      );
      final slowFn = FirebaseFunctions(
        projectId: 'p2-fn',
        gatewayOrigin: 'http://127.0.0.1:${slowServer.port}',
      );
      await expectLater(
        slowFn
            .httpsCallable(
              'slowCall',
              options: HttpsCallableOptions(timeout: const Duration(milliseconds: 80)),
            )
            .call<Object?>(),
        throwsA(isA<FirebaseFunctionsException>().having((e) => e.code, 'code', 'deadline-exceeded')),
      );
      await socketClosed.future.timeout(const Duration(seconds: 2));
      fn.dispose();
      slowFn.dispose();
    } finally {
      await server.close(force: true);
      await slowServer.close();
      HttpOverrides.global = prevOverrides;
    }
  });

  test('P2-F14: omits Authorization header when AuthLens is switched to Anon or different user', () async {
    setupMockFirebase();
    final harness = MockBridgeHarness();
    final client = harness.createClient();
    harness.channel.toServerController.stream.listen((raw) {
      if (raw is String && raw.contains('"type":"attach"')) {
        harness.ackAttach(clientSessionId: 'sess-fn-lens');
      }
    });
    final auth = PyricFirebaseAuthPlatform(bridgeClient: client);
    await client.connect();
    await pumpEventQueue();

    final seenAuthHeaders = <String?>[];
    final capturingTransport = _HeaderCapturingTransport(seenAuthHeaders);
    final fn = FirebaseFunctions(
      projectId: 'p2-fn',
      gatewayOrigin: 'http://127.0.0.1:5174',
      authPlatform: auth,
      transport: capturingTransport,
    );

    auth.switchAuthLens(AuthLens.anon);
    await fn.httpsCallable('whoami').call<Object?>();
    expect(seenAuthHeaders.last, isNull);

    auth.switchAuthLens(AuthLens.asUser(uid: 'impersonated-bob'));
    await fn.httpsCallable('whoami').call<Object?>();
    expect(seenAuthHeaders.last, isNull);

    await auth.dispose();
    await client.disconnect();
  });
}

class _HeaderCapturingTransport implements FunctionsHttpTransport {
  final List<String?> seenAuthHeaders;
  _HeaderCapturingTransport(this.seenAuthHeaders);

  @override
  Future<FunctionsHttpResponse> postJson({
    required Uri uri,
    required Map<String, String> headers,
    required String body,
  }) async {
    seenAuthHeaders.add(headers['Authorization']);
    return const FunctionsHttpResponse(statusCode: 200, body: '{"data":"ok"}');
  }

  @override
  Future<FunctionsSseStreamResponse> postSse({
    required Uri uri,
    required Map<String, String> headers,
    required String body,
  }) async =>
      const FunctionsSseStreamResponse(statusCode: 200, byteStream: Stream.empty());

  @override
  void close() {}
}
