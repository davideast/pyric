import 'dart:async';

/// Resolves an App Check token string to attach onto outgoing bridge frames and
/// Storage HTTP byte-route requests.
typedef BridgeAppCheckTokenProvider = Future<String?> Function();

const Set<String> _internalAppCheckSkipMethods = <String>{
  'sandbox.clock',
  'auth.restorePortSession',
};

const Set<String> _internalAppCheckSkipSubTargets = <String>{
  'authState',
  'idToken',
  'events',
  'presence',
};

/// Returns [params] with `appCheckToken` attached when [tokenProvider] is set
/// and [method] is not an internal or `appCheck.*` RPC.
Future<Map<String, dynamic>> attachAppCheckTokenToOpParams(
  String method,
  Map<String, dynamic> params,
  BridgeAppCheckTokenProvider? tokenProvider,
) async {
  if (tokenProvider == null) return params;
  if (method.startsWith('appCheck.') ||
      _internalAppCheckSkipMethods.contains(method)) {
    return params;
  }
  final existing = params['appCheckToken'];
  if (existing is String && existing.isNotEmpty) {
    return params;
  }
  String? token;
  try {
    token = await tokenProvider();
  } catch (_) {
    token = null;
  }
  if (token == null || token.isEmpty) return params;
  return <String, dynamic>{
    ...params,
    'appCheckToken': token,
  };
}

/// Reports whether [target] is a bridge-internal subscription stream that never
/// carries an App Check token.
bool isInternalAppCheckSubscriptionTarget(Object? target) {
  return target is String && _internalAppCheckSkipSubTargets.contains(target);
}

/// Resolves a token for a non-internal subscription target, returning `null` on
/// skip or provider failure.
Future<String?> resolveAppCheckTokenForSubscription(
  Object? target,
  BridgeAppCheckTokenProvider? tokenProvider,
) async {
  if (tokenProvider == null) return null;
  if (isInternalAppCheckSubscriptionTarget(target)) return null;
  try {
    final token = await tokenProvider();
    return (token != null && token.isNotEmpty) ? token : null;
  } catch (_) {
    return null;
  }
}

/// Returns [headers] with `X-Firebase-AppCheck` populated when [tokenProvider]
/// yields a non-empty token and no App Check header is already present.
Future<Map<String, String>> attachAppCheckHeaderToHttpHeaders(
  Map<String, String> headers,
  BridgeAppCheckTokenProvider? tokenProvider,
) async {
  if (tokenProvider == null) return headers;
  for (final key in headers.keys) {
    if (key.toLowerCase() == 'x-firebase-appcheck') {
      return headers;
    }
  }
  String? token;
  try {
    token = await tokenProvider();
  } catch (_) {
    token = null;
  }
  if (token == null || token.isEmpty) return headers;
  return <String, String>{
    ...headers,
    'X-Firebase-AppCheck': token,
  };
}
