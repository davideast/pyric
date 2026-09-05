import 'dart:async';

import '../auth/auth_lens.dart';
import 'pyric_firestore_platform.dart';

/// Creates a broadcast stream that establishes an underlying bridge subscription
/// stamped with the current [AuthLens] and re-subscribes whenever [authLensChanges] emits.
Stream<T> createResubscribingStream<T>({
  required PyricFirestorePlatform firestore,
  required Stream<dynamic> Function(Map<String, dynamic> actAs)
      createSubscription,
  required T Function(dynamic event, T? previous) mapEvent,
}) {
  late StreamController<T> controller;
  StreamSubscription<dynamic>? bridgeSub;
  StreamSubscription<AuthLens>? authLensSub;
  T? previousValue;

  void startListening(Map<String, dynamic> actAs) {
    bridgeSub?.cancel();
    final stream = createSubscription(actAs);
    bridgeSub = stream.listen(
      (rawEvent) {
        try {
          final mapped = mapEvent(rawEvent, previousValue);
          previousValue = mapped;
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
    },
  );

  return controller.stream;
}
