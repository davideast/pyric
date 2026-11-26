import 'dart:async';
import 'dart:convert';

import 'bridge_frame_codec.dart';
import 'bridge_reconnect_policy.dart';
import 'exceptions.dart';

class _PendingOp {
  final Completer<dynamic> completer;
  final Timer timer;

  _PendingOp(this.completer, this.timer);
}

/// An operation issued while the client is not attached, or whose frame was
/// positively refused by the transport before leaving the device.
class _HeldOp {
  final String method;
  final Map<String, dynamic> params;
  final Map<String, dynamic>? actAs;
  final Duration? timeout;
  final Completer<dynamic> completer = Completer<dynamic>();
  late final Timer deadline;

  _HeldOp(this.method, this.params, this.actAs, this.timeout);
}

/// Manages in-flight (`_pendingOps`) and held (`_heldOps`) worker operations
/// according to ADR-0019 D1-D5 and the 2026-10-17 refusal-hold amendment.
class BridgeOperationQueue {
  final Duration defaultOpTimeout;
  final Duration Function() holdDeadline;
  final bool Function() isConnected;
  final bool Function() isDisposed;
  final bool Function() hasEverAttached;
  final String? Function() clientSessionId;
  final bool Function(String encodedFrame) trySendEncoded;
  final void Function() ensureInitialAttempt;
  final void Function(PyricBridgeException exception) onDenial;

  int _opCounter = 0;
  final Map<String, _PendingOp> _pendingOps = {};
  final List<_HeldOp> _heldOps = [];
  bool _sendingHeldOps = false;

  BridgeOperationQueue({
    required this.defaultOpTimeout,
    required this.holdDeadline,
    required this.isConnected,
    required this.isDisposed,
    required this.hasEverAttached,
    required this.clientSessionId,
    required this.trySendEncoded,
    required this.ensureInitialAttempt,
    required this.onDenial,
  });

  /// Dispatches an app operation immediately if attached with no queued held
  /// operations ahead of it; otherwise holds it in FIFO issue order.
  Future<dynamic> enqueueOrDispatch(
    String method,
    Map<String, dynamic> params, {
    Map<String, dynamic>? actAs,
    Duration? timeout,
  }) {
    final sendsNow = isConnected() && !_sendingHeldOps && _heldOps.isEmpty;
    if (sendsNow) {
      return dispatch(
        method,
        params,
        actAs: actAs,
        timeout: timeout,
        holdOnRefusal: true,
      );
    }
    return _hold(_HeldOp(method, params, actAs, timeout));
  }

  /// Sends one operation directly on the current socket. Restore traffic sets
  /// [holdOnRefusal] to `false` so a refused restore fails the restore instead
  /// of entering the hold queue.
  Future<dynamic> dispatch(
    String method,
    Map<String, dynamic> params, {
    Map<String, dynamic>? actAs,
    Duration? timeout,
    required bool holdOnRefusal,
  }) {
    final id = 'rop-${++_opCounter}';
    final String encoded;
    try {
      encoded = _encodeOp(id, method, params, actAs: actAs);
    } catch (e) {
      return Future<dynamic>.error(
        PyricBridgeException(
          code: 'unavailable',
          message: 'Failed to encode op for bridge: $e',
        ),
      );
    }

    final completer = Completer<dynamic>();
    final opTimeout = timeout ?? defaultOpTimeout;
    final timer = Timer(opTimeout, () {
      if (_pendingOps.remove(id) != null) {
        completer.completeError(
          PyricBridgeException(
            code: 'deadline-exceeded',
            message:
                'Remote sandbox op timed out after ${opTimeout.inMilliseconds}ms (op: $method). Is pyric sandbox still running?',
          ),
        );
      }
    });

    _pendingOps[id] = _PendingOp(completer, timer);
    final accepted = trySendEncoded(encoded);
    if (accepted) {
      return completer.future;
    }

    timer.cancel();
    _pendingOps.remove(id);
    if (holdOnRefusal && !isDisposed()) {
      return _hold(_HeldOp(method, params, actAs, timeout));
    }
    if (!completer.isCompleted) {
      completer.completeError(
        const PyricBridgeException(
          code: 'unavailable',
          message: 'Cannot send message: WebSocket is closed.',
        ),
      );
    }
    return completer.future;
  }

  /// Releases held operations in admission order after attach and restore.
  void sendHeld() {
    _sendingHeldOps = true;
    try {
      while (_heldOps.isNotEmpty && isConnected()) {
        final held = _heldOps.removeAt(0);
        final id = 'rop-${++_opCounter}';
        final String encoded;
        try {
          encoded = _encodeOp(id, held.method, held.params, actAs: held.actAs);
        } catch (e) {
          held.deadline.cancel();
          if (!held.completer.isCompleted) {
            held.completer.completeError(
              PyricBridgeException(
                code: 'unavailable',
                message: 'Failed to encode op for bridge: $e',
              ),
            );
          }
          continue;
        }

        final completer = Completer<dynamic>();
        final opTimeout = held.timeout ?? defaultOpTimeout;
        final timer = Timer(opTimeout, () {
          if (_pendingOps.remove(id) != null) {
            completer.completeError(
              PyricBridgeException(
                code: 'deadline-exceeded',
                message:
                    'Remote sandbox op timed out after ${opTimeout.inMilliseconds}ms (op: ${held.method}). Is pyric sandbox still running?',
              ),
            );
          }
        });

        _pendingOps[id] = _PendingOp(completer, timer);
        final accepted = trySendEncoded(encoded);
        if (!accepted) {
          timer.cancel();
          _pendingOps.remove(id);
          if (!isDisposed() && !held.completer.isCompleted) {
            // Keep the refused operation at the front with its original deadline.
            _heldOps.insert(0, held);
          } else {
            held.deadline.cancel();
            if (!held.completer.isCompleted) {
              if (completer.isCompleted) {
                held.completer.complete(completer.future);
              } else {
                held.completer.completeError(
                  const PyricBridgeException(
                    code: 'unavailable',
                    message: 'PyricBridgeClient disconnected.',
                  ),
                );
              }
            }
          }
          break;
        }

        held.deadline.cancel();
        if (!held.completer.isCompleted) {
          held.completer.complete(completer.future);
        }
      }
    } finally {
      _sendingHeldOps = false;
    }
  }

  void handleWorkerRes(Map<String, dynamic> msg) {
    final id = msg['id'] as String?;
    if (id == null) return;

    final pending = _pendingOps.remove(id);
    if (pending == null) return;

    pending.timer.cancel();
    if (msg['ok'] == true) {
      pending.completer.complete(msg['value']);
      return;
    }

    final errorMap = msg['error'] is Map
        ? Map<String, dynamic>.from(msg['error'] as Map)
        : const <String, dynamic>{};
    final parsed = parseBridgeError(
      errorMap,
      defaultCode: 'unknown',
      defaultMessage: 'unknown sandbox error',
    );
    if (parsed.isDenial) {
      onDenial(parsed.exception);
    }
    pending.completer.completeError(parsed.exception);
  }

  void failPending(PyricBridgeException error) {
    final pending = _pendingOps.values.toList();
    _pendingOps.clear();
    for (final op in pending) {
      op.timer.cancel();
      op.completer.completeError(error);
    }
  }

  void failHeld(PyricBridgeException error) {
    final taken = List<_HeldOp>.of(_heldOps);
    _heldOps.clear();
    for (final held in taken) {
      held.deadline.cancel();
      if (!held.completer.isCompleted) {
        held.completer.completeError(error);
      }
    }
  }

  Future<dynamic> _hold(_HeldOp held) {
    held.deadline = Timer(holdDeadline(), () {
      final wasSent = !_heldOps.remove(held);
      if (wasSent) return;
      if (!held.completer.isCompleted) {
        held.completer.completeError(const PyricBridgeException(
          code: 'unavailable',
          message: bridgeHoldExpiredMessage,
        ));
      }
    });
    _heldOps.add(held);
    if (!hasEverAttached()) {
      ensureInitialAttempt();
    }
    return held.completer.future;
  }

  String _encodeOp(
    String id,
    String method,
    Map<String, dynamic> params, {
    Map<String, dynamic>? actAs,
  }) {
    final sessionId = clientSessionId();
    final opPayload = <String, dynamic>{
      'method': method,
      ...params,
      if (actAs != null) 'actAs': actAs,
    };
    return jsonEncode(<String, dynamic>{
      'type': 'worker-op',
      'id': id,
      if (sessionId != null) 'clientSessionId': sessionId,
      'op': opPayload,
    });
  }
}
