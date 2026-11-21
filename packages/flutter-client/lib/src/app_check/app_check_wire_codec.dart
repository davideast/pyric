import 'package:firebase_app_check_platform_interface/firebase_app_check_platform_interface.dart';
import 'package:firebase_core/firebase_core.dart' show FirebaseException;

import '../transport/exceptions.dart';

/// Default standard App Check token lifetime (1 hour) when the wire payload omits `expireTimeMillis`.
const int defaultAppCheckTtlMillis = 3600 * 1000;

/// Proactive refresh lead window (5 minutes) before a cached standard App Check token expires.
const int appCheckRefreshBufferMillis = 5 * 60 * 1000;

/// Resolved configuration extracted from [FirebaseAppCheckPlatform.activate].
class ResolvedAppCheckActivation {
  final String provider;
  final String? debugToken;
  final String? siteKey;

  const ResolvedAppCheckActivation({
    required this.provider,
    this.debugToken,
    this.siteKey,
  });
}

/// Decoded wire payload returned by `appCheck.getToken` or `appCheck.getLimitedUseToken`.
class DecodedAppCheckToken {
  final String token;
  final int expireTimeMillis;

  const DecodedAppCheckToken({
    required this.token,
    required this.expireTimeMillis,
  });

  /// Converts this wire payload into a FlutterFire [AppCheckTokenResult].
  AppCheckTokenResult toTokenResult() {
    return AppCheckTokenResult(
      token: token,
      expirationTime: DateTime.fromMillisecondsSinceEpoch(expireTimeMillis),
    );
  }

  /// Whether this cached token remains fresh at [nowMillis] outside the refresh buffer.
  bool isFreshAt(int nowMillis, {int bufferMillis = appCheckRefreshBufferMillis}) {
    return expireTimeMillis > nowMillis + bufferMillis;
  }
}

/// Normalizes bridge App Check error codes by stripping leading `appCheck/` or `app-check/` prefixes.
String normalizeAppCheckErrorCode(String rawCode) {
  final trimmed = rawCode.trim();
  if (trimmed.isEmpty) {
    return 'unknown';
  }
  final slashIndex = trimmed.indexOf('/');
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    final prefix = trimmed.substring(0, slashIndex).toLowerCase();
    if (prefix == 'appcheck' || prefix == 'app-check' || prefix == 'app_check') {
      return trimmed.substring(slashIndex + 1);
    }
  }
  return trimmed;
}

/// Wraps bridge or decoding failures into a standard `firebase_app_check` [FirebaseException].
FirebaseException mapToAppCheckFirebaseException(Object error, [StackTrace? stackTrace]) {
  if (error is FirebaseException) {
    return error;
  }
  if (error is PyricBridgeException) {
    return FirebaseException(
      plugin: 'firebase_app_check',
      code: normalizeAppCheckErrorCode(error.code),
      message: error.message,
      stackTrace: stackTrace,
    );
  }
  return FirebaseException(
    plugin: 'firebase_app_check',
    code: 'unknown',
    message: error.toString(),
    stackTrace: stackTrace,
  );
}

/// Converts camelCase provider identifiers (`playIntegrity`, `appAttest`) to kebab-case wire names.
String normalizeProviderTypeSlug(String rawType) {
  final trimmed = rawType.trim();
  if (trimmed.isEmpty) {
    return 'debug';
  }
  final buffer = StringBuffer();
  for (var i = 0; i < trimmed.length; i += 1) {
    final codeUnit = trimmed.codeUnitAt(i);
    final isUpperAscii = codeUnit >= 65 && codeUnit <= 90;
    if (isUpperAscii) {
      if (i > 0 && trimmed.codeUnitAt(i - 1) != 45) {
        buffer.write('-');
      }
      buffer.writeCharCode(codeUnit + 32);
    } else if (codeUnit == 95) {
      buffer.write('-');
    } else {
      buffer.writeCharCode(codeUnit);
    }
  }
  return buffer.toString();
}

/// Resolves the canonical Pyric wire provider descriptor from [FirebaseAppCheckPlatform.activate] arguments.
ResolvedAppCheckActivation resolveAppCheckActivation({
  WebProvider? webProvider,
  AndroidProvider? androidProvider,
  AppleProvider? appleProvider,
  AndroidAppCheckProvider? providerAndroid,
  AppleAppCheckProvider? providerApple,
  WindowsAppCheckProvider? providerWindows,
}) {
  if (providerAndroid != null) {
    if (providerAndroid is AndroidDebugProvider) {
      return ResolvedAppCheckActivation(
        provider: 'debug',
        debugToken: providerAndroid.debugToken,
      );
    }
    if (providerAndroid is AndroidPlayIntegrityProvider) {
      return const ResolvedAppCheckActivation(provider: 'play-integrity');
    }
    if (providerAndroid is AndroidReCaptchaProvider) {
      return ResolvedAppCheckActivation(
        provider: 'recaptcha',
        siteKey: providerAndroid.siteKey,
      );
    }
    return ResolvedAppCheckActivation(
      provider: normalizeProviderTypeSlug(providerAndroid.type),
    );
  }

  if (providerApple != null) {
    if (providerApple is AppleDebugProvider) {
      return ResolvedAppCheckActivation(
        provider: 'debug',
        debugToken: providerApple.debugToken,
      );
    }
    if (providerApple is AppleAppAttestProvider) {
      return const ResolvedAppCheckActivation(provider: 'app-attest');
    }
    if (providerApple is AppleDeviceCheckProvider) {
      return const ResolvedAppCheckActivation(provider: 'device-check');
    }
    if (providerApple is AppleAppAttestWithDeviceCheckFallbackProvider) {
      return const ResolvedAppCheckActivation(
        provider: 'app-attest-with-device-check-fallback',
      );
    }
    if (providerApple is AppleReCaptchaProvider) {
      return ResolvedAppCheckActivation(
        provider: 'recaptcha',
        siteKey: providerApple.siteKey,
      );
    }
    return ResolvedAppCheckActivation(
      provider: normalizeProviderTypeSlug(providerApple.type),
    );
  }

  if (webProvider != null) {
    if (webProvider is WebDebugProvider) {
      return ResolvedAppCheckActivation(
        provider: 'debug',
        debugToken: webProvider.debugToken,
      );
    }
    if (webProvider is ReCaptchaEnterpriseProvider) {
      return ResolvedAppCheckActivation(
        provider: 'recaptcha-enterprise',
        siteKey: webProvider.siteKey,
      );
    }
    if (webProvider is ReCaptchaV3Provider) {
      return ResolvedAppCheckActivation(
        provider: 'recaptcha-v3',
        siteKey: webProvider.siteKey,
      );
    }
    return ResolvedAppCheckActivation(
      provider: 'recaptcha-v3',
      siteKey: webProvider.siteKey,
    );
  }

  if (providerWindows != null) {
    if (providerWindows is WindowsDebugProvider) {
      return ResolvedAppCheckActivation(
        provider: 'debug',
        debugToken: providerWindows.debugToken,
      );
    }
    return ResolvedAppCheckActivation(
      provider: normalizeProviderTypeSlug(providerWindows.type),
    );
  }

  if (androidProvider != null) {
    switch (androidProvider) {
      case AndroidProvider.debug:
        return const ResolvedAppCheckActivation(provider: 'debug');
      case AndroidProvider.playIntegrity:
        return const ResolvedAppCheckActivation(provider: 'play-integrity');
    }
  }

  if (appleProvider != null) {
    switch (appleProvider) {
      case AppleProvider.debug:
        return const ResolvedAppCheckActivation(provider: 'debug');
      case AppleProvider.appAttest:
        return const ResolvedAppCheckActivation(provider: 'app-attest');
      case AppleProvider.deviceCheck:
        return const ResolvedAppCheckActivation(provider: 'device-check');
      case AppleProvider.appAttestWithDeviceCheckFallback:
        return const ResolvedAppCheckActivation(
          provider: 'app-attest-with-device-check-fallback',
        );
    }
  }

  return const ResolvedAppCheckActivation(provider: 'debug');
}

/// Validates and decodes the map returned by `appCheck.getToken` or `appCheck.getLimitedUseToken`.
DecodedAppCheckToken decodeWireAppCheckToken(
  Object? raw, {
  required int nowMillis,
}) {
  if (raw is! Map) {
    throw FirebaseException(
      plugin: 'firebase_app_check',
      code: 'invalid-response',
      message: 'App Check response from Pyric bridge was not an object.',
    );
  }
  final tokenVal = raw['token'];
  if (tokenVal is! String || tokenVal.isEmpty) {
    throw FirebaseException(
      plugin: 'firebase_app_check',
      code: 'invalid-response',
      message: 'App Check response from Pyric bridge lacked a non-empty token.',
    );
  }
  final expireRaw = raw['expireTimeMillis'];
  final expireTimeMillis = expireRaw is num
      ? expireRaw.toInt()
      : nowMillis + defaultAppCheckTtlMillis;
  return DecodedAppCheckToken(
    token: tokenVal,
    expireTimeMillis: expireTimeMillis,
  );
}
