import 'package:meta/meta.dart';

/// Overall authorization status for displaying notifications on the device.
enum AuthorizationStatus {
  /// The app is authorized to create notifications.
  authorized,

  /// The app is not authorized to create notifications.
  denied,

  /// The app user has not yet chosen whether to allow notifications.
  notDetermined,

  /// The app is currently authorized to post non-interrupting user notifications.
  provisional,
}

/// Platform-specific availability state for an individual Apple notification setting.
enum AppleNotificationSetting {
  /// This notification setting is turned off by the user.
  disabled,

  /// This notification setting is turned on.
  enabled,

  /// This setting is not supported on the current platform or OS version.
  notSupported,
}

/// Controls when notification previews are shown on Apple platforms.
enum AppleShowPreviewSetting {
  /// Notification previews are always shown.
  always,

  /// Notification previews are never shown.
  never,

  /// Notification preview configuration is not supported on this platform.
  notSupported,

  /// Notification previews are only shown when the device is unlocked.
  whenAuthenticated,
}

/// Snapshot of device notification permission and presentation settings.
@immutable
class NotificationSettings {
  /// Constructs a [NotificationSettings] snapshot.
  const NotificationSettings({
    required this.alert,
    required this.announcement,
    required this.authorizationStatus,
    required this.badge,
    required this.carPlay,
    required this.lockScreen,
    required this.notificationCenter,
    required this.showPreviews,
    required this.timeSensitive,
    required this.criticalAlert,
    required this.sound,
    required this.providesAppNotificationSettings,
  });

  /// Constructs default authorized sandbox [NotificationSettings].
  const NotificationSettings.authorizedDefaults({
    this.alert = AppleNotificationSetting.enabled,
    this.announcement = AppleNotificationSetting.disabled,
    this.authorizationStatus = AuthorizationStatus.authorized,
    this.badge = AppleNotificationSetting.enabled,
    this.carPlay = AppleNotificationSetting.disabled,
    this.lockScreen = AppleNotificationSetting.enabled,
    this.notificationCenter = AppleNotificationSetting.enabled,
    this.showPreviews = AppleShowPreviewSetting.always,
    this.timeSensitive = AppleNotificationSetting.disabled,
    this.criticalAlert = AppleNotificationSetting.disabled,
    this.sound = AppleNotificationSetting.enabled,
    this.providesAppNotificationSettings = AppleNotificationSetting.disabled,
  });

  /// Decodes [NotificationSettings] from a platform or wire map.
  factory NotificationSettings.fromMap(Map<String, dynamic> map) {
    return NotificationSettings(
      alert: _parseAppleSetting(map['alert']),
      announcement: _parseAppleSetting(map['announcement']),
      authorizationStatus: _parseAuthStatus(map['authorizationStatus']),
      badge: _parseAppleSetting(map['badge']),
      carPlay: _parseAppleSetting(map['carPlay']),
      lockScreen: _parseAppleSetting(map['lockScreen']),
      notificationCenter: _parseAppleSetting(map['notificationCenter']),
      showPreviews: _parsePreviewSetting(map['showPreviews']),
      timeSensitive: _parseAppleSetting(map['timeSensitive']),
      criticalAlert: _parseAppleSetting(map['criticalAlert']),
      sound: _parseAppleSetting(map['sound']),
      providesAppNotificationSettings: _parseAppleSetting(
        map['providesAppNotificationSettings'],
      ),
    );
  }

  /// Whether notifications alert visibly.
  final AppleNotificationSetting alert;

  /// Whether Siri can announce notifications.
  final AppleNotificationSetting announcement;

  /// Overall notification authorization status.
  final AuthorizationStatus authorizationStatus;

  /// Whether app icon badges are enabled.
  final AppleNotificationSetting badge;

  /// Whether CarPlay notifications are enabled.
  final AppleNotificationSetting carPlay;

  /// Whether notifications appear on the lock screen.
  final AppleNotificationSetting lockScreen;

  /// Whether notifications appear in Notification Center.
  final AppleNotificationSetting notificationCenter;

  /// When notification previews are displayed.
  final AppleShowPreviewSetting showPreviews;

  /// Whether time-sensitive notifications are enabled.
  final AppleNotificationSetting timeSensitive;

  /// Whether critical alert notifications are enabled.
  final AppleNotificationSetting criticalAlert;

  /// Whether notification sounds are enabled.
  final AppleNotificationSetting sound;

  /// Whether the app provides an in-app notification settings screen.
  final AppleNotificationSetting providesAppNotificationSettings;

  /// Serializes these [NotificationSettings] into a JSON-safe map.
  Map<String, dynamic> toMap() {
    return <String, dynamic>{
      'alert': alert.name,
      'announcement': announcement.name,
      'authorizationStatus': authorizationStatus.name,
      'badge': badge.name,
      'carPlay': carPlay.name,
      'lockScreen': lockScreen.name,
      'notificationCenter': notificationCenter.name,
      'showPreviews': showPreviews.name,
      'timeSensitive': timeSensitive.name,
      'criticalAlert': criticalAlert.name,
      'sound': sound.name,
      'providesAppNotificationSettings': providesAppNotificationSettings.name,
    };
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is NotificationSettings &&
        other.alert == alert &&
        other.announcement == announcement &&
        other.authorizationStatus == authorizationStatus &&
        other.badge == badge &&
        other.carPlay == carPlay &&
        other.lockScreen == lockScreen &&
        other.notificationCenter == notificationCenter &&
        other.showPreviews == showPreviews &&
        other.timeSensitive == timeSensitive &&
        other.criticalAlert == criticalAlert &&
        other.sound == sound &&
        other.providesAppNotificationSettings ==
            providesAppNotificationSettings;
  }

  @override
  int get hashCode => Object.hash(
        alert,
        announcement,
        authorizationStatus,
        badge,
        carPlay,
        lockScreen,
        notificationCenter,
        showPreviews,
        timeSensitive,
        criticalAlert,
        sound,
        providesAppNotificationSettings,
      );

  @override
  String toString() =>
      'NotificationSettings(authorizationStatus: ${authorizationStatus.name})';
}

AuthorizationStatus _parseAuthStatus(Object? raw) {
  if (raw is int && raw >= 0 && raw < AuthorizationStatus.values.length) {
    return AuthorizationStatus.values[raw];
  }
  if (raw is String) {
    for (final value in AuthorizationStatus.values) {
      if (value.name == raw) return value;
    }
  }
  return AuthorizationStatus.notDetermined;
}

AppleNotificationSetting _parseAppleSetting(Object? raw) {
  if (raw is int && raw >= 0 && raw < AppleNotificationSetting.values.length) {
    return AppleNotificationSetting.values[raw];
  }
  if (raw is String) {
    for (final value in AppleNotificationSetting.values) {
      if (value.name == raw) return value;
    }
  }
  return AppleNotificationSetting.notSupported;
}

AppleShowPreviewSetting _parsePreviewSetting(Object? raw) {
  if (raw is int && raw >= 0 && raw < AppleShowPreviewSetting.values.length) {
    return AppleShowPreviewSetting.values[raw];
  }
  if (raw is String) {
    for (final value in AppleShowPreviewSetting.values) {
      if (value.name == raw) return value;
    }
  }
  return AppleShowPreviewSetting.notSupported;
}
