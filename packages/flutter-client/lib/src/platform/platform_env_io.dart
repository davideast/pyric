import 'dart:io' show Platform;

/// Reads [key] from `dart:io` [Platform.environment].
String? readPlatformEnvironment(String key) => Platform.environment[key];
