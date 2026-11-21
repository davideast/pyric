import 'package:firebase_core/firebase_core.dart';
import 'package:meta/meta.dart';

import '../transport/bridge_client.dart';
import 'remote_message.dart';

/// Plugin identifier attached to every [FirebaseException] thrown by `pyric_messaging`.
const String firebaseMessagingPluginName = 'firebase_messaging';

final RegExp _bareTopicRegex = RegExp(r'^[a-zA-Z0-9-_.~%]{1,900}$');

/// Foreground notification presentation options for Apple platforms.
@immutable
class ForegroundPresentationOptions {
  const ForegroundPresentationOptions({
    this.alert = false,
    this.badge = false,
    this.sound = false,
  });

  final bool alert;
  final bool badge;
  final bool sound;

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is ForegroundPresentationOptions &&
        other.alert == alert &&
        other.badge == badge &&
        other.sound == sound;
  }

  @override
  int get hashCode => Object.hash(alert, badge, sound);
}

/// Result returned by Pyric's `messaging.send` broker operation.
@immutable
class AcceptedMessagingSend {
  const AcceptedMessagingSend({
    required this.name,
    required this.messageId,
    required this.target,
    required this.validateOnly,
  });

  factory AcceptedMessagingSend.fromMap(Map<String, dynamic> map) {
    final rawTarget = map['target'];
    return AcceptedMessagingSend(
      name: (map['name'] as String?) ?? '',
      messageId: (map['messageId'] as String?) ?? '',
      target: rawTarget is Map
          ? Map<String, dynamic>.unmodifiable(
              Map<String, dynamic>.from(rawTarget),
            )
          : const <String, dynamic>{},
      validateOnly: map['validateOnly'] == true,
    );
  }

  final String name;
  final String messageId;
  final Map<String, dynamic> target;
  final bool validateOnly;
}

/// Result returned by Pyric's `messaging.deliver` sandbox injection driver.
@immutable
class MessagingDeliveryResult {
  const MessagingDeliveryResult({
    required this.route,
    required this.handlerCount,
    required this.message,
  });

  factory MessagingDeliveryResult.fromMap(Map<String, dynamic> map) {
    final rawPayload = map['payload'];
    final payloadMap = rawPayload is Map
        ? Map<String, dynamic>.from(rawPayload)
        : const <String, dynamic>{};
    return MessagingDeliveryResult(
      route: (map['route'] as String?) ?? 'background',
      handlerCount: (map['handlerCount'] as num?)?.toInt() ?? 0,
      message: remoteMessageFromDeliveredPayload(payloadMap),
    );
  }

  final String route;
  final int handlerCount;
  final RemoteMessage message;
}

/// Specialized [FirebaseException] carrying the broker's raw status when a
/// `messaging.send` or topic operation fails on the host.
class FirebaseMessagingSendException extends FirebaseException {
  FirebaseMessagingSendException({
    required super.code,
    required super.message,
    this.status,
    super.stackTrace,
  }) : super(plugin: firebaseMessagingPluginName);

  /// Raw `google.rpc.Code` status reported by the Pyric broker (e.g. `NOT_FOUND`).
  final String? status;
}

/// Validates and normalizes an FCM topic name (`[a-zA-Z0-9-_.~%]{1,900}` with
/// optional `/topics/` prefix), throwing a [FirebaseException] if invalid.
String validateAndNormalizeTopic(String topic) {
  final bare =
      topic.startsWith('/topics/') ? topic.substring('/topics/'.length) : topic;
  if (bare.isEmpty || !_bareTopicRegex.hasMatch(bare)) {
    throw FirebaseException(
      plugin: firebaseMessagingPluginName,
      code: 'invalid-topic-name',
      message:
          'Messaging topic "$topic" must match [a-zA-Z0-9-_.~%]{1,900} (with optional /topics/ prefix).',
    );
  }
  return bare;
}

/// Validates a client visibility state (`'visible'` or `'hidden'`).
String validateVisibilityState(String state) {
  if (state == 'visible' || state == 'hidden') {
    return state;
  }
  throw FirebaseException(
    plugin: firebaseMessagingPluginName,
    code: 'invalid-argument',
    message:
        'Visibility state must be "visible" or "hidden", received "$state".',
  );
}

/// Converts a Pyric `DeliveredPayload` JSON object into a [RemoteMessage].
RemoteMessage remoteMessageFromDeliveredPayload(Map<String, dynamic> payload) {
  return RemoteMessage.fromMap(payload);
}

/// Maps a [PyricBridgeException] or unexpected error to a `firebase_messaging`
/// [FirebaseException].
FirebaseException mapMessagingBridgeException(
  Object error, [
  StackTrace? stackTrace,
]) {
  if (error is FirebaseException) {
    return error;
  }
  if (error is PyricBridgeException) {
    final rawCode = error.code;
    final message = error.message;
    if (rawCode == 'messaging/disabled') {
      return FirebaseException(
        plugin: firebaseMessagingPluginName,
        code: 'disabled',
        message: message,
        stackTrace: stackTrace,
      );
    }
    if (rawCode.startsWith('messaging/')) {
      return FirebaseException(
        plugin: firebaseMessagingPluginName,
        code: rawCode.substring('messaging/'.length),
        message: message,
        stackTrace: stackTrace,
      );
    }
    if (rawCode == 'NOT_FOUND' || rawCode == 'UNREGISTERED') {
      return FirebaseMessagingSendException(
        code: 'unregistered',
        status: rawCode,
        message: message,
        stackTrace: stackTrace,
      );
    }
    if (rawCode == 'INVALID_ARGUMENT') {
      final lowerMessage = message.toLowerCase();
      final mappedCode = lowerMessage.contains('topic')
          ? 'invalid-topic-name'
          : 'invalid-argument';
      return FirebaseMessagingSendException(
        code: mappedCode,
        status: rawCode,
        message: message,
        stackTrace: stackTrace,
      );
    }
    if (rawCode == 'PERMISSION_DENIED') {
      return FirebaseMessagingSendException(
        code: 'permission-denied',
        status: rawCode,
        message: message,
        stackTrace: stackTrace,
      );
    }
    final normalized = rawCode.toLowerCase().replaceAll('_', '-');
    return FirebaseException(
      plugin: firebaseMessagingPluginName,
      code: normalized.isEmpty ? 'unknown' : normalized,
      message: message,
      stackTrace: stackTrace,
    );
  }
  return FirebaseException(
    plugin: firebaseMessagingPluginName,
    code: 'unknown',
    message: error.toString(),
    stackTrace: stackTrace,
  );
}
