import 'package:meta/meta.dart';

/// Relative priority for an [AndroidNotification].
enum AndroidNotificationPriority {
  minimumPriority,
  lowPriority,
  defaultPriority,
  highPriority,
  maximumPriority,
}

/// Lock-screen visibility level for an [AndroidNotification].
enum AndroidNotificationVisibility {
  secret,
  private,
  public,
}

/// Android-specific notification display properties on a [RemoteNotification].
@immutable
class AndroidNotification {
  const AndroidNotification({
    this.channelId,
    this.clickAction,
    this.color,
    this.count,
    this.imageUrl,
    this.link,
    this.priority = AndroidNotificationPriority.defaultPriority,
    this.smallIcon,
    this.sound,
    this.ticker,
    this.visibility = AndroidNotificationVisibility.private,
    this.tag,
  });

  factory AndroidNotification.fromMap(Map<String, dynamic> map) {
    return AndroidNotification(
      channelId: map['channelId'] as String?,
      clickAction: map['clickAction'] as String?,
      color: map['color'] as String?,
      count: (map['count'] as num?)?.toInt(),
      imageUrl: map['imageUrl'] as String?,
      link: map['link'] as String?,
      priority: _parseAndroidPriority(map['priority']),
      smallIcon: map['smallIcon'] as String?,
      sound: map['sound'] as String?,
      ticker: map['ticker'] as String?,
      visibility: _parseAndroidVisibility(map['visibility']),
      tag: map['tag'] as String?,
    );
  }

  final String? channelId;
  final String? clickAction;
  final String? color;
  final int? count;
  final String? imageUrl;
  final String? link;
  final AndroidNotificationPriority priority;
  final String? smallIcon;
  final String? sound;
  final String? ticker;
  final AndroidNotificationVisibility visibility;
  final String? tag;

  Map<String, dynamic> toMap() {
    return <String, dynamic>{
      'channelId': channelId,
      'clickAction': clickAction,
      'color': color,
      'count': count,
      'imageUrl': imageUrl,
      'link': link,
      'priority': priority.index,
      'smallIcon': smallIcon,
      'sound': sound,
      'ticker': ticker,
      'visibility': visibility.index,
      'tag': tag,
    };
  }
}

/// Sound configuration for an [AppleNotification].
@immutable
class AppleNotificationSound {
  const AppleNotificationSound({
    this.critical = false,
    this.name,
    this.volume = 0,
  });

  factory AppleNotificationSound.fromMap(Map<String, dynamic> map) {
    return AppleNotificationSound(
      critical: map['critical'] == true,
      name: map['name'] as String?,
      volume: (map['volume'] as num?) ?? 0,
    );
  }

  final bool critical;
  final String? name;
  final num volume;

  Map<String, dynamic> toMap() {
    return <String, dynamic>{
      'critical': critical,
      'name': name,
      'volume': volume,
    };
  }
}

/// Apple-specific notification display properties on a [RemoteNotification].
@immutable
class AppleNotification {
  const AppleNotification({
    this.badge,
    this.sound,
    this.imageUrl,
    this.subtitle,
    this.subtitleLocArgs = const <String>[],
    this.subtitleLocKey,
  });

  factory AppleNotification.fromMap(Map<String, dynamic> map) {
    final rawSound = map['sound'];
    return AppleNotification(
      badge: map['badge'] as String?,
      sound: rawSound is Map
          ? AppleNotificationSound.fromMap(Map<String, dynamic>.from(rawSound))
          : null,
      imageUrl: map['imageUrl'] as String?,
      subtitle: map['subtitle'] as String?,
      subtitleLocArgs: _stringList(map['subtitleLocArgs']),
      subtitleLocKey: map['subtitleLocKey'] as String?,
    );
  }

  final String? badge;
  final AppleNotificationSound? sound;
  final String? imageUrl;
  final String? subtitle;
  final List<String> subtitleLocArgs;
  final String? subtitleLocKey;

  Map<String, dynamic> toMap() {
    return <String, dynamic>{
      'badge': badge,
      'sound': sound?.toMap(),
      'imageUrl': imageUrl,
      'subtitle': subtitle,
      'subtitleLocArgs': subtitleLocArgs,
      'subtitleLocKey': subtitleLocKey,
    };
  }
}

/// Web-specific notification display properties on a [RemoteNotification].
@immutable
class WebNotification {
  const WebNotification({
    this.analyticsLabel,
    this.image,
    this.link,
  });

  factory WebNotification.fromMap(Map<String, dynamic> map) {
    return WebNotification(
      analyticsLabel: map['analyticsLabel'] as String?,
      image: map['image'] as String?,
      link: map['link'] as String?,
    );
  }

  final String? analyticsLabel;
  final String? image;
  final String? link;

  Map<String, dynamic> toMap() {
    return <String, dynamic>{
      'analyticsLabel': analyticsLabel,
      'image': image,
      'link': link,
    };
  }
}

/// Display notification block carried on a [RemoteMessage].
@immutable
class RemoteNotification {
  const RemoteNotification({
    this.android,
    this.apple,
    this.web,
    this.title,
    this.titleLocArgs = const <String>[],
    this.titleLocKey,
    this.body,
    this.bodyLocArgs = const <String>[],
    this.bodyLocKey,
  });

  /// Decodes a [RemoteNotification] from either a FlutterFire platform map or a
  /// Pyric `DeliveredPayload.notification` block (`{title, body, image}`).
  factory RemoteNotification.fromMap(Map<String, dynamic> map) {
    final rawAndroid = map['android'];
    final rawApple = map['apple'];
    final rawWeb = map['web'];
    final topLevelImage =
        (map['image'] as String?) ?? (map['imageUrl'] as String?);
    final hasExplicitSubBlock =
        rawAndroid is Map || rawApple is Map || rawWeb is Map;

    return RemoteNotification(
      title: map['title'] as String?,
      titleLocArgs: _stringList(map['titleLocArgs']),
      titleLocKey: map['titleLocKey'] as String?,
      body: map['body'] as String?,
      bodyLocArgs: _stringList(map['bodyLocArgs']),
      bodyLocKey: map['bodyLocKey'] as String?,
      android: rawAndroid is Map
          ? AndroidNotification.fromMap(Map<String, dynamic>.from(rawAndroid))
          : (!hasExplicitSubBlock && topLevelImage != null
              ? AndroidNotification(imageUrl: topLevelImage)
              : null),
      apple: rawApple is Map
          ? AppleNotification.fromMap(Map<String, dynamic>.from(rawApple))
          : (!hasExplicitSubBlock && topLevelImage != null
              ? AppleNotification(imageUrl: topLevelImage)
              : null),
      web: rawWeb is Map
          ? WebNotification.fromMap(Map<String, dynamic>.from(rawWeb))
          : (!hasExplicitSubBlock && topLevelImage != null
              ? WebNotification(image: topLevelImage)
              : null),
    );
  }

  final AndroidNotification? android;
  final AppleNotification? apple;
  final WebNotification? web;
  final String? title;
  final List<String> titleLocArgs;
  final String? titleLocKey;
  final String? body;
  final List<String> bodyLocArgs;
  final String? bodyLocKey;

  Map<String, dynamic> toMap() {
    return <String, dynamic>{
      'title': title,
      'titleLocArgs': titleLocArgs,
      'titleLocKey': titleLocKey,
      'body': body,
      'bodyLocArgs': bodyLocArgs,
      'bodyLocKey': bodyLocKey,
      if (android != null) 'android': android!.toMap(),
      if (apple != null) 'apple': apple!.toMap(),
      if (web != null) 'web': web!.toMap(),
    };
  }
}

/// Cloud Messaging message delivered via foreground, background, or notification-open streams.
@immutable
class RemoteMessage {
  const RemoteMessage({
    this.senderId,
    this.category,
    this.collapseKey,
    this.contentAvailable = false,
    this.data = const <String, dynamic>{},
    this.from,
    this.messageId,
    this.messageType,
    this.mutableContent = false,
    this.notification,
    this.sentTime,
    this.threadId,
    this.ttl,
  });

  /// Decodes a [RemoteMessage] from a FlutterFire map or a Pyric `DeliveredPayload` frame.
  factory RemoteMessage.fromMap(Map<String, dynamic> map) {
    final rawData = map['data'];
    final rawNotification = map['notification'];
    return RemoteMessage(
      senderId: map['senderId'] as String?,
      category: map['category'] as String?,
      collapseKey: map['collapseKey'] as String?,
      contentAvailable: map['contentAvailable'] == true,
      data: rawData is Map
          ? Map<String, dynamic>.unmodifiable(Map<String, dynamic>.from(rawData))
          : const <String, dynamic>{},
      from: map['from'] as String?,
      messageId: map['messageId'] as String?,
      messageType: map['messageType'] as String?,
      mutableContent: map['mutableContent'] == true,
      notification: rawNotification is Map
          ? RemoteNotification.fromMap(
              Map<String, dynamic>.from(rawNotification),
            )
          : null,
      sentTime: _parseSentTime(map['sentTime']),
      threadId: map['threadId'] as String?,
      ttl: (map['ttl'] as num?)?.toInt(),
    );
  }

  final String? senderId;
  final String? category;
  final String? collapseKey;
  final bool contentAvailable;
  final Map<String, dynamic> data;
  final String? from;
  final String? messageId;
  final String? messageType;
  final bool mutableContent;
  final RemoteNotification? notification;
  final DateTime? sentTime;
  final String? threadId;
  final int? ttl;

  Map<String, dynamic> toMap() {
    return <String, dynamic>{
      'senderId': senderId,
      'category': category,
      'collapseKey': collapseKey,
      'contentAvailable': contentAvailable,
      'data': Map<String, dynamic>.from(data),
      'from': from,
      'messageId': messageId,
      'messageType': messageType,
      'mutableContent': mutableContent,
      'notification': notification?.toMap(),
      'sentTime': sentTime?.millisecondsSinceEpoch,
      'threadId': threadId,
      'ttl': ttl,
    };
  }
}

List<String> _stringList(Object? raw) {
  if (raw is List) {
    return List<String>.unmodifiable(raw.map((item) => item.toString()));
  }
  return const <String>[];
}

DateTime? _parseSentTime(Object? raw) {
  if (raw == null) return null;
  if (raw is int) return DateTime.fromMillisecondsSinceEpoch(raw);
  if (raw is num) return DateTime.fromMillisecondsSinceEpoch(raw.toInt());
  if (raw is String) {
    final millis = int.tryParse(raw);
    if (millis != null) return DateTime.fromMillisecondsSinceEpoch(millis);
    return DateTime.tryParse(raw);
  }
  return null;
}

AndroidNotificationPriority _parseAndroidPriority(Object? raw) {
  if (raw is int &&
      raw >= 0 &&
      raw < AndroidNotificationPriority.values.length) {
    return AndroidNotificationPriority.values[raw];
  }
  if (raw is String) {
    for (final value in AndroidNotificationPriority.values) {
      if (value.name == raw) return value;
    }
  }
  return AndroidNotificationPriority.defaultPriority;
}

AndroidNotificationVisibility _parseAndroidVisibility(Object? raw) {
  if (raw is int &&
      raw >= 0 &&
      raw < AndroidNotificationVisibility.values.length) {
    return AndroidNotificationVisibility.values[raw];
  }
  if (raw is String) {
    for (final value in AndroidNotificationVisibility.values) {
      if (value.name == raw) return value;
    }
  }
  return AndroidNotificationVisibility.private;
}
