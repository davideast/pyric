import 'dart:async';

import '../transport/bridge_client.dart';

/// Opens a finite Gemini `streamGenerateContent` subscription over [bridgeClient]
/// and adapts `{ chunk }`, `{ done: true }`, and `{ __error }` bridge frames into
/// a clean single-subscription [Stream].
///
/// Guarantees:
/// - Chunks are decoded in wire arrival order via [decodeChunk].
/// - Terminal `{ done: true }` immediately cancels the underlying
///   [PyricBridgeClient.subscribeRaw] subscription so `_activeSubs` removes `subId`
///   (preventing stale replay on later WebSocket reconnects) and closes the stream.
/// - Consumer `StreamSubscription.cancel()` cancels the underlying subscription
///   immediately (sending `worker-unsub` over the wire to halt the host pump)
///   or aborts before subscribing if [buildSubPayload] is still in flight.
/// - Bridge and decoding errors are mapped once through [mapError] with zero
///   leaked [StreamController]s or dangling subscriptions.
Stream<T> streamAiGenerateContent<T>({
  required PyricBridgeClient bridgeClient,
  required Future<Map<String, dynamic>> Function() buildSubPayload,
  required T Function(Object? rawChunk) decodeChunk,
  required Object Function(Object error) mapError,
  Duration? timeout,
}) {
  late final StreamController<T> controller;
  StreamSubscription<dynamic>? upstreamSub;
  StreamSubscription<BridgeConnectionState>? stateSub;
  Timer? timeoutTimer;
  Future<void>? detachFuture;
  var isCancelled = false;
  var isFinished = false;

  Future<void> detachUpstream() {
    timeoutTimer?.cancel();
    timeoutTimer = null;
    final activeState = stateSub;
    stateSub = null;
    if (activeState != null) {
      unawaited(activeState.cancel());
    }
    final inFlight = detachFuture;
    if (inFlight != null) {
      return inFlight;
    }
    final active = upstreamSub;
    upstreamSub = null;
    if (active == null) {
      final resolved = Future<void>.value();
      detachFuture = resolved;
      return resolved;
    }
    final pending = Future<void>.sync(active.cancel);
    detachFuture = pending;
    return pending;
  }

  void failAndClose(Object error, [StackTrace? stackTrace]) {
    if (isCancelled || isFinished) {
      return;
    }
    isFinished = true;
    unawaited(detachUpstream());
    if (!controller.isClosed) {
      final mapped = mapError(error);
      if (stackTrace != null) {
        controller.addError(mapped, stackTrace);
      } else {
        controller.addError(mapped);
      }
      unawaited(controller.close());
    }
  }

  controller = StreamController<T>(
    onListen: () {
      Future<void>(() async {
        if (isCancelled || isFinished) {
          return;
        }
        final Map<String, dynamic> subPayload;
        try {
          subPayload = await buildSubPayload();
        } catch (error, stackTrace) {
          failAndClose(error, stackTrace);
          return;
        }
        if (isCancelled || isFinished) {
          return;
        }
        if (!bridgeClient.isConnected) {
          try {
            await bridgeClient.connect();
          } catch (error, stackTrace) {
            failAndClose(error, stackTrace);
            return;
          }
        }
        if (isCancelled || isFinished) {
          return;
        }

        final effectiveTimeout = timeout ?? const Duration(seconds: 180);
        if (effectiveTimeout > Duration.zero) {
          timeoutTimer = Timer(effectiveTimeout, () {
            failAndClose(
              PyricBridgeException(
                code: 'deadline-exceeded',
                message:
                    'AI stream timed out after ${effectiveTimeout.inMilliseconds}ms.',
              ),
            );
          });
        }

        final Stream<dynamic> rawStream;
        try {
          rawStream = bridgeClient.subscribeRaw(subPayload);
        } catch (error, stackTrace) {
          failAndClose(error, stackTrace);
          return;
        }

        stateSub = bridgeClient.connectionStates.listen(
          (state) {
            if (isCancelled || isFinished) return;
            if (state == BridgeConnectionState.interrupted ||
                state == BridgeConnectionState.closed) {
              failAndClose(
                const PyricBridgeException(
                  code: 'unavailable',
                  message:
                      'AI stream interrupted by WebSocket disconnect before completion.',
                ),
              );
            }
          },
          onError: (Object _, StackTrace __) {},
        );

        upstreamSub = rawStream.listen(
          (dynamic rawFrame) {
            if (isCancelled || isFinished || controller.isClosed) {
              return;
            }
            if (rawFrame is! Map) {
              failAndClose(
                const PyricBridgeException(
                  code: 'parse-failed',
                  message: 'Expected JSON object snapshot frame for AI stream.',
                ),
              );
              return;
            }
            final frameMap = Map<String, dynamic>.from(rawFrame);
            if (frameMap.containsKey('__error')) {
              final errObj = frameMap['__error'];
              if (errObj is Map) {
                final errMap = Map<String, dynamic>.from(errObj);
                failAndClose(
                  PyricBridgeException(
                    code: errMap['code'] as String? ?? 'unknown',
                    message:
                        errMap['message'] as String? ?? 'AI stream failed.',
                    envelope: errMap['aiEnvelope'] ?? errMap['envelope'],
                  ),
                );
              } else {
                failAndClose(
                  PyricBridgeException(
                    code: 'unknown',
                    message: errObj?.toString() ?? 'AI stream failed.',
                  ),
                );
              }
              return;
            }

            if (frameMap['done'] == true) {
              isFinished = true;
              unawaited(
                detachUpstream().whenComplete(() {
                  if (!controller.isClosed) {
                    return controller.close();
                  }
                }),
              );
              return;
            }

            final Object? chunkPayload = frameMap.containsKey('chunk')
                ? frameMap['chunk']
                : frameMap;
            try {
              final decoded = decodeChunk(chunkPayload);
              if (!isCancelled && !isFinished && !controller.isClosed) {
                controller.add(decoded);
              }
            } catch (error, stackTrace) {
              failAndClose(error, stackTrace);
            }
          },
          onError: (Object error, StackTrace stackTrace) {
            failAndClose(error, stackTrace);
          },
          onDone: () {
            if (isCancelled || isFinished) {
              return;
            }
            upstreamSub = null;
            failAndClose(
              const PyricBridgeException(
                code: 'unavailable',
                message: 'AI stream ended before receiving terminal done frame.',
              ),
            );
          },
          cancelOnError: true,
        );

        if (controller.isPaused) {
          upstreamSub?.pause();
        }
      });
    },
    onPause: () {
      upstreamSub?.pause();
    },
    onResume: () {
      upstreamSub?.resume();
    },
    onCancel: () async {
      isCancelled = true;
      isFinished = true;
      await detachUpstream();
    },
  );

  return controller.stream;
}
