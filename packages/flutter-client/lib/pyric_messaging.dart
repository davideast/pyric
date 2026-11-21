/// Pyric Flutter Firebase Cloud Messaging (`firebase_messaging`) client library.
library;

export 'package:firebase_core/firebase_core.dart'
    show FirebaseApp, FirebaseException;

export 'src/messaging/firebase_messaging.dart'
    show
        BackgroundMessageHandler,
        FirebaseMessaging,
        PyricFirebaseMessaging,
        PyricMessaging;
export 'src/messaging/messaging_settings.dart'
    show
        AppleNotificationSetting,
        AppleShowPreviewSetting,
        AuthorizationStatus,
        NotificationSettings;
export 'src/messaging/messaging_wire_codec.dart'
    show
        AcceptedMessagingSend,
        FirebaseMessagingSendException,
        ForegroundPresentationOptions,
        MessagingDeliveryResult,
        firebaseMessagingPluginName,
        mapMessagingBridgeException,
        remoteMessageFromDeliveredPayload,
        validateAndNormalizeTopic,
        validateVisibilityState;
export 'src/messaging/remote_message.dart'
    show
        AndroidNotification,
        AndroidNotificationPriority,
        AndroidNotificationVisibility,
        AppleNotification,
        AppleNotificationSound,
        RemoteMessage,
        RemoteNotification,
        WebNotification;
export 'src/transport/bridge_client.dart'
    show BridgeConnectionState, PyricBridgeClient, PyricBridgeException;
