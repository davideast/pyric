import 'platform_env_stub.dart'
    if (dart.library.io) 'platform_env_io.dart' as impl;

/// Reads process environment variable [key] on IO platforms, or returns `null` on Web.
String? readPlatformEnvironment(String key) => impl.readPlatformEnvironment(key);
