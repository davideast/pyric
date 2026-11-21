import 'dart:async';

import '../auth/auth_lens.dart';
import '../transport/bridge_client.dart';
import 'pyric_firestore_lifecycle.dart';
import 'pyric_firestore_platform.dart';

/// Creates a broadcast stream that establishes an underlying bridge subscription
/// stamped with the current [AuthLens], integrates with [PyricFirestoreLifecycle]
/// (`disableNetwork`, `enableNetwork`, `terminate`, `snapshotsInSync`), and
/// re-subscribes whenever [authLensChanges] emits.
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
  int? listenerId;
  T? previousValue;
  dynamic lastEvent;
  var hasEvent = false;
  var hasOnlineEvent = false;
  var closedByTerminate = false;

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

  void startListening(Map<String, dynamic> actAs) {
    if (closedByTerminate || !firestore.lifecycle.isNetworkEnabled) {
      return;
    }
    bridgeSub?.cancel();
    final stream = createSubscription(actAs);
    bridgeSub = stream.listen(
      (rawEvent) {
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
        if (!controller.isClosed) {
          controller.addError(err, st);
        }
      },
    );
  }

  controller = StreamController<T>.broadcast(
    onListen: () {
      firestore.lifecycle.ensureActiveAndMarkStarted();
      listenerId = firestore.lifecycle.registerListener(
        ManagedFirestoreListener(
          target: target,
          includeMetadataChanges: includeMetadataChanges,
          hasDeliveredAny: () => hasEvent,
          hasDeliveredOnline: () => hasOnlineEvent,
          suspendFromHost: () {
            bridgeSub?.cancel();
            bridgeSub = null;
          },
          resumeOnHost: () {
            startListening(firestore.effectiveAuthLens);
          },
          deliverOfflineProjection: deliverOfflineNow,
          cancelFromTerminate: () {
            closedByTerminate = true;
            authLensSub?.cancel();
            authLensSub = null;
            bridgeSub?.cancel();
            bridgeSub = null;
            if (!controller.isClosed) {
              controller.close();
            }
          },
        ),
      );

      if (!firestore.lifecycle.isNetworkEnabled) {
        scheduleMicrotask(deliverOfflineNow);
      } else {
        startListening(firestore.effectiveAuthLens);
      }

      authLensSub = firestore.authLensChanges.skip(1).listen((newLens) {
        if (!closedByTerminate && firestore.lifecycle.isNetworkEnabled) {
          startListening(newLens.toMap());
        }
      });
    },
    onCancel: () async {
      if (listenerId != null) {
        firestore.lifecycle.unregisterListener(listenerId!);
        listenerId = null;
      }
      await authLensSub?.cancel();
      authLensSub = null;
      await bridgeSub?.cancel();
      bridgeSub = null;
      previousValue = null;
      lastEvent = null;
      hasEvent = false;
      hasOnlineEvent = false;
    },
  );

  return controller.stream;
}
