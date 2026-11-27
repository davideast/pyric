import 'dart:async';

import '../auth/auth_lens.dart';
import '../transport/bridge_client.dart';
import 'pyric_firestore_lifecycle.dart';
import 'pyric_firestore_platform.dart';

bool _isRecoverableRulesOrAuthDenial(Object err) {
  if (err is! PyricBridgeException) return false;
  if (err.denialContext != null) return true;
  final code = err.code.toLowerCase();
  return code == 'permission-denied' ||
      code == 'permission_denied' ||
      code == 'firestore/permission-denied' ||
      code == 'unauthenticated';
}

/// Creates a broadcast stream that establishes an underlying bridge subscription
/// stamped with the current [AuthLens], integrates with [PyricFirestoreLifecycle]
/// (`disableNetwork`, `enableNetwork`, `terminate`, `snapshotsInSync`), and
/// re-subscribes whenever [authLensChanges] emits a lens distinct from the
/// active subscription's lens.
Stream<T> createResubscribingStream<T>({
  required PyricFirestorePlatform firestore,
  required Map<String, dynamic> target,
  required bool includeMetadataChanges,
  required Stream<dynamic> Function(Map<String, dynamic> actAs)
      createSubscription,
  required T Function(dynamic event, T? previous) mapEvent,
  required T Function(T? previous) buildOfflineProjection,
  void Function(dynamic event)? recordOnlineEvent,
  bool Function(T previous, T next)? shouldSuppressMetadataOnly,
  T Function(dynamic lastEvent)? mapGap,
}) {
  late StreamController<T> controller;
  StreamSubscription<dynamic>? bridgeSub;
  StreamSubscription<AuthLens>? authLensSub;
  StreamSubscription<BridgeConnectionState>? bridgeStateSub;
  int? listenerId;
  int listenGeneration = 0;
  AuthLens? activeLens;
  T? previousValue;
  dynamic lastEvent;
  var hasEvent = false;
  var hasOnlineEvent = false;
  var closedByTerminate = false;

  void closeFromBridge() {
    if (controller.isClosed) return;
    listenGeneration++;
    final prevListenerId = listenerId;
    listenerId = null;
    final prevBridgeSub = bridgeSub;
    bridgeSub = null;
    final prevAuthLensSub = authLensSub;
    authLensSub = null;
    final prevBridgeStateSub = bridgeStateSub;
    bridgeStateSub = null;
    activeLens = null;
    if (prevListenerId != null) {
      firestore.lifecycle.unregisterListener(prevListenerId);
    }
    prevBridgeSub?.cancel();
    prevAuthLensSub?.cancel();
    prevBridgeStateSub?.cancel();
    controller.close();
  }

  void emitSnapshot(T value, {required bool isOnline}) {
    if (closedByTerminate || controller.isClosed) return;
    if (!includeMetadataChanges &&
        previousValue != null &&
        shouldSuppressMetadataOnly != null &&
        shouldSuppressMetadataOnly(previousValue as T, value)) {
      previousValue = value;
      hasEvent = true;
      if (isOnline) hasOnlineEvent = true;
      return;
    }
    previousValue = value;
    hasEvent = true;
    if (isOnline) hasOnlineEvent = true;
    firestore.lifecycle.runSnapshotDelivery(() {
      if (!controller.isClosed) {
        controller.add(value);
      }
    });
  }

  void deliverOfflineNow() {
    if (closedByTerminate || controller.isClosed) return;
    final projected = buildOfflineProjection(previousValue);
    emitSnapshot(projected, isOnline: false);
  }

  void startListening(AuthLens lens, int generation) {
    if (closedByTerminate ||
        controller.isClosed ||
        generation != listenGeneration ||
        !firestore.lifecycle.isNetworkEnabled) {
      return;
    }
    activeLens = lens;
    final prevBridgeSub = bridgeSub;
    bridgeSub = null;
    prevBridgeSub?.cancel();

    final Stream<dynamic> stream;
    try {
      stream = createSubscription(lens.toMap());
    } catch (e, st) {
      scheduleMicrotask(() {
        if (generation != listenGeneration || controller.isClosed) return;
        controller.addError(e, st);
        closeFromBridge();
      });
      return;
    }

    var sawRecoverableDenial = false;
    late final StreamSubscription<dynamic> currentSub;
    currentSub = stream.listen(
      (rawEvent) {
        if (generation != listenGeneration || !identical(bridgeSub, currentSub)) {
          return;
        }
        try {
          if (rawEvent is BridgeSubscriptionGap) {
            final gapMapper = mapGap;
            if (gapMapper == null || !hasEvent) return;
            final gap = gapMapper(lastEvent);
            emitSnapshot(gap, isOnline: false);
            return;
          }
          if (recordOnlineEvent != null) {
            recordOnlineEvent(rawEvent);
          }
          final mapped = mapEvent(rawEvent, previousValue);
          lastEvent = rawEvent;
          emitSnapshot(mapped, isOnline: true);
        } catch (e, st) {
          if (!controller.isClosed) {
            controller.addError(e, st);
          }
        }
      },
      onError: (Object err, StackTrace st) {
        if (generation != listenGeneration || !identical(bridgeSub, currentSub)) {
          return;
        }
        if (_isRecoverableRulesOrAuthDenial(err)) {
          sawRecoverableDenial = true;
        }
        if (!controller.isClosed) {
          controller.addError(err, st);
        }
      },
      onDone: () {
        if (generation != listenGeneration || !identical(bridgeSub, currentSub)) {
          return;
        }
        bridgeSub = null;
        if (!closedByTerminate &&
            !firestore.bridgeClient.isDisposed &&
            sawRecoverableDenial) {
          return;
        }
        closeFromBridge();
      },
    );
    bridgeSub = currentSub;
  }

  controller = StreamController<T>.broadcast(
    sync: true,
    onListen: () {
      final generation = ++listenGeneration;
      if (firestore.bridgeClient.isDisposed) {
        scheduleMicrotask(() {
          if (generation != listenGeneration || controller.isClosed) return;
          controller.addError(const PyricBridgeException(
            code: 'unavailable',
            message: 'PyricBridgeClient has been disposed.',
          ));
          controller.close();
        });
        return;
      }

      firestore.lifecycle.ensureActiveAndMarkStarted();
      listenerId = firestore.lifecycle.registerListener(
        ManagedFirestoreListener(
          target: target,
          includeMetadataChanges: includeMetadataChanges,
          hasDeliveredAny: () => hasEvent,
          hasDeliveredOnline: () => hasOnlineEvent,
          suspendFromHost: () {
            final prev = bridgeSub;
            bridgeSub = null;
            prev?.cancel();
          },
          resumeOnHost: () {
            if (generation != listenGeneration || closedByTerminate) return;
            startListening(firestore.effectiveLens, generation);
          },
          deliverOfflineProjection: deliverOfflineNow,
          cancelFromTerminate: () {
            closedByTerminate = true;
            closeFromBridge();
          },
        ),
      );

      final initialLens = firestore.effectiveLens;
      activeLens = initialLens;
      if (!firestore.lifecycle.isNetworkEnabled) {
        scheduleMicrotask(deliverOfflineNow);
      } else {
        startListening(initialLens, generation);
      }

      bridgeStateSub = firestore.bridgeClient.connectionStates.listen(
        null,
        onDone: () {
          if (generation != listenGeneration ||
              closedByTerminate ||
              controller.isClosed) {
            return;
          }
          if (bridgeSub == null) {
            closeFromBridge();
          }
        },
      );

      authLensSub = firestore.authLensChanges.listen(
        (newLens) {
          if (generation != listenGeneration || closedByTerminate) return;
          if (newLens == activeLens) return;
          activeLens = newLens;
          previousValue = null;
          lastEvent = null;
          hasEvent = false;
          hasOnlineEvent = false;
          if (firestore.lifecycle.isNetworkEnabled) {
            startListening(newLens, generation);
          } else {
            deliverOfflineNow();
          }
        },
        onError: (Object _, StackTrace __) {},
      );
    },
    onCancel: () {
      listenGeneration++;
      final prevListenerId = listenerId;
      listenerId = null;
      final prevBridgeSub = bridgeSub;
      bridgeSub = null;
      final prevAuthLensSub = authLensSub;
      authLensSub = null;
      final prevBridgeStateSub = bridgeStateSub;
      bridgeStateSub = null;
      activeLens = null;
      previousValue = null;
      lastEvent = null;
      hasEvent = false;
      hasOnlineEvent = false;
      if (prevListenerId != null) {
        firestore.lifecycle.unregisterListener(prevListenerId);
      }
      if (prevBridgeSub != null) unawaited(prevBridgeSub.cancel());
      if (prevAuthLensSub != null) unawaited(prevAuthLensSub.cancel());
      if (prevBridgeStateSub != null) unawaited(prevBridgeStateSub.cancel());
    },
  );

  return controller.stream;
}
