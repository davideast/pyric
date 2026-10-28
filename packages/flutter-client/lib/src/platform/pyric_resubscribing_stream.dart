import 'dart:async';

import '../auth/auth_lens.dart';
import '../transport/bridge_client.dart';
import 'pyric_firestore_platform.dart';

/// Creates a broadcast stream that establishes an underlying bridge subscription
/// stamped with the current [AuthLens] and re-subscribes whenever [authLensChanges] emits.
///
/// When the bridge connection drops, [mapGap] receives the last bridge event
/// and returns the snapshot that reports the gap (the same documents with
/// `isFromCache` set). The bridge signals a gap only to subscriptions opened
/// with `includeMetadataChanges`.
Stream<T> createResubscribingStream<T>({
  required PyricFirestorePlatform firestore,
  required Stream<dynamic> Function(Map<String, dynamic> actAs)
      createSubscription,
  required T Function(dynamic event, T? previous) mapEvent,
  T Function(dynamic lastEvent)? mapGap,
}) {
  late StreamController<T> controller;
  StreamSubscription<dynamic>? bridgeSub;
  StreamSubscription<AuthLens>? authLensSub;
  T? previousValue;
  dynamic lastEvent;
  var hasEvent = false;

  void startListening(Map<String, dynamic> actAs) {
    bridgeSub?.cancel();
    final stream = createSubscription(actAs);
    bridgeSub = stream.listen(
      (rawEvent) {
        try {
          if (rawEvent is BridgeSubscriptionGap) {
            final gapMapper = mapGap;
            if (gapMapper == null || !hasEvent) return;
            final gap = gapMapper(lastEvent);
            previousValue = gap;
            controller.add(gap);
            return;
          }
          final mapped = mapEvent(rawEvent, previousValue);
          previousValue = mapped;
          lastEvent = rawEvent;
          hasEvent = true;
          controller.add(mapped);
        } catch (e, st) {
          controller.addError(e, st);
        }
      },
      onError: (err, st) {
        controller.addError(err, st);
      },
    );
  }

  controller = StreamController<T>.broadcast(
    onListen: () {
      final initialLens = firestore.effectiveAuthLens;
      startListening(initialLens);

      authLensSub = firestore.authLensChanges.skip(1).listen((newLens) {
        startListening(newLens.toMap());
      });
    },
    onCancel: () async {
      await authLensSub?.cancel();
      authLensSub = null;
      await bridgeSub?.cancel();
      bridgeSub = null;
      previousValue = null;
      lastEvent = null;
      hasEvent = false;
    },
  );

  return controller.stream;
}
