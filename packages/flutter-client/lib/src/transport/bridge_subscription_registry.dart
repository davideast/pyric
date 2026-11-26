import 'dart:async';

import 'package:collection/collection.dart';

import 'bridge_frame_codec.dart';
import 'bridge_reconnect_policy.dart';
import 'exceptions.dart';

class _ActiveSub {
  final StreamController<dynamic> controller;
  final Map<String, dynamic> payload;
  bool hasValue = false;
  dynamic lastValue;
  bool awaitsRestoredValue = false;

  _ActiveSub(this.controller, this.payload);

  bool get includesMetadataChanges => payload['includeMetadataChanges'] == true;
}

/// Manages active `worker-sub` registrations in insertion order for replay on
/// re-attach, gap reporting, terminal `__error` unsubscription, and synchronous
/// shutdown draining.
class BridgeSubscriptionRegistry {
  final bool Function() isConnected;
  final bool Function() isDisposed;
  final bool Function() hasEverAttached;
  final String? Function() clientSessionId;
  final bool Function(Map<String, dynamic> frame) trySendMessage;
  final void Function() ensureInitialAttempt;
  final void Function(PyricBridgeException exception) onDenial;

  int _subCounter = 0;
  final Map<String, _ActiveSub> _activeSubs = {};

  BridgeSubscriptionRegistry({
    required this.isConnected,
    required this.isDisposed,
    required this.hasEverAttached,
    required this.clientSessionId,
    required this.trySendMessage,
    required this.ensureInitialAttempt,
    required this.onDenial,
  });

  Stream<dynamic> subscribeRaw(Map<String, dynamic> subPayload) {
    if (isDisposed()) {
      throw const PyricBridgeException(
        code: 'unavailable',
        message: 'PyricBridgeClient has been disposed.',
      );
    }

    late StreamController<dynamic> controller;
    String? currentSubId;

    controller = StreamController<dynamic>.broadcast(
      onListen: () {
        if (isDisposed()) {
          controller.addError(const PyricBridgeException(
            code: 'unavailable',
            message: 'PyricBridgeClient has been disposed.',
          ));
          controller.close();
          return;
        }
        final subId = 'rsub-${++_subCounter}';
        currentSubId = subId;
        final sub = _ActiveSub(controller, subPayload);
        _activeSubs[subId] = sub;
        if (isConnected()) {
          _sendSub(subId, sub);
        } else if (!hasEverAttached()) {
          ensureInitialAttempt();
        }
      },
      onCancel: () {
        final subId = currentSubId;
        currentSubId = null;
        if (subId != null && _activeSubs.remove(subId) != null && isConnected()) {
          final sessionId = clientSessionId();
          trySendMessage({
            'type': 'worker-unsub',
            'subId': subId,
            if (sessionId != null) 'clientSessionId': sessionId,
          });
        }
      },
    );

    return controller.stream;
  }

  void reportGap() {
    for (final sub in _activeSubs.values) {
      final reportsGap = sub.includesMetadataChanges && sub.hasValue;
      if (reportsGap && !sub.controller.isClosed) {
        sub.controller.add(BridgeSubscriptionGap.instance);
      }
    }
  }

  void restoreAll() {
    for (final entry in _activeSubs.entries.toList()) {
      final sub = entry.value;
      sub.awaitsRestoredValue = sub.hasValue;
      _sendSub(entry.key, sub);
    }
  }

  void handleWorkerSnap(Map<String, dynamic> msg) {
    final subId = msg['subId'] as String?;
    if (subId == null) return;

    final sub = _activeSubs[subId];
    if (sub == null) return;

    final dynamic value = msg['value'];
    if (value is Map && value.containsKey('__error')) {
      _activeSubs.remove(subId);
      if (isConnected()) {
        final sessionId = clientSessionId();
        trySendMessage({
          'type': 'worker-unsub',
          'subId': subId,
          if (sessionId != null) 'clientSessionId': sessionId,
        });
      }

      final rawError = value['__error'];
      final errMap = rawError is Map
          ? Map<String, dynamic>.from(rawError)
          : const <String, dynamic>{};
      final parsed = parseBridgeError(
        errMap,
        defaultCode: 'permission-denied',
        defaultMessage: 'Subscription error',
      );
      if (parsed.isDenial) {
        onDenial(parsed.exception);
      }
      if (!sub.controller.isClosed) {
        sub.controller.addError(parsed.exception);
        sub.controller.close();
      }
      return;
    }

    if (sub.awaitsRestoredValue) {
      sub.awaitsRestoredValue = false;
      final unchanged =
          const DeepCollectionEquality().equals(sub.lastValue, value);
      if (unchanged && !sub.includesMetadataChanges) return;
    }
    sub.hasValue = true;
    sub.lastValue = value;
    if (!sub.controller.isClosed) {
      sub.controller.add(value);
    }
  }

  List<Future<void>> closeAll(PyricBridgeException error) {
    final closeFutures = <Future<void>>[];
    final subs = _activeSubs.values.toList();
    _activeSubs.clear();
    for (final sub in subs) {
      if (sub.controller.isClosed) continue;
      sub.controller.addError(error);
      closeFutures.add(sub.controller.close());
    }
    return closeFutures;
  }

  void _sendSub(String subId, _ActiveSub sub) {
    final sessionId = clientSessionId();
    trySendMessage({
      'type': 'worker-sub',
      'subId': subId,
      if (sessionId != null) 'clientSessionId': sessionId,
      'sub': sub.payload,
    });
  }
}
