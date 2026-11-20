import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';

import '../transport/bridge_client.dart';

/// Registered JWT and Firebase Identity Platform claim keys excluded from
/// developer `customClaims` maps.
const Set<String> standardJwtClaimKeys = <String>{
  'firebase',
  'uid',
  'user_id',
  'sub',
  'iss',
  'aud',
  'iat',
  'exp',
  'auth_time',
  'email',
  'email_verified',
  'phone_number',
  'name',
  'picture',
  'nonce',
  'provider_id',
};

/// Strips any leading `auth/` namespace prefix from a bridge error code so
/// `FirebaseAuthException.code` matches FlutterFire conventions.
String normalizeAuthErrorCode(String rawCode) {
  if (rawCode.startsWith('auth/')) {
    return rawCode.substring(5);
  }
  return rawCode;
}

/// Returns true when [normalizedCode] indicates the signed-in account was
/// disabled, deleted, or had its session invalidated on the host.
bool isAccountInvalidatingAuthCode(String normalizedCode) {
  return normalizedCode == 'user-disabled' ||
      normalizedCode == 'user-token-expired' ||
      normalizedCode == 'user-not-found';
}

/// Maps a [PyricBridgeException] to a [FirebaseAuthException] with a
/// normalized FlutterFire error code.
Object mapBridgeAuthError(Object error) {
  if (error is FirebaseAuthException) {
    return error;
  }
  if (error is PyricBridgeException) {
    return FirebaseAuthException(
      code: normalizeAuthErrorCode(error.code),
      message: error.message,
    );
  }
  return error;
}

/// Extracts developer custom claims from a decoded ID token claims map,
/// returning `null` when no non-standard claims are present.
Map<String, dynamic>? extractCustomClaimsFromJwtClaims(
  Map<dynamic, dynamic>? rawClaims,
) {
  if (rawClaims == null) {
    return null;
  }
  final filtered = <String, dynamic>{};
  for (final entry in rawClaims.entries) {
    final key = entry.key;
    if (key is String && !standardJwtClaimKeys.contains(key)) {
      filtered[key] = entry.value;
    }
  }
  if (filtered.isEmpty) {
    return null;
  }
  return filtered;
}

/// Parses an ISO-8601 string or epoch-millisecond value into epoch
/// milliseconds for `InternalUserInfo` and `InternalIdTokenResult`.
int? parseWireTimestampMillis(dynamic value) {
  if (value == null) {
    return null;
  }
  if (value is num) {
    return value.toInt();
  }
  if (value is String) {
    final parsed = DateTime.tryParse(value);
    if (parsed != null) {
      return parsed.millisecondsSinceEpoch;
    }
    final asNum = num.tryParse(value);
    if (asNum != null) {
      return asNum.toInt();
    }
  }
  return null;
}

/// Strips scheme prefixes and trailing slashes from an emulator host string.
String sanitizeEmulatorHost(String host) {
  var cleaned = host.trim();
  for (final prefix in const <String>['ws://', 'wss://', 'http://', 'https://']) {
    if (cleaned.startsWith(prefix)) {
      cleaned = cleaned.substring(prefix.length);
      break;
    }
  }
  while (cleaned.endsWith('/')) {
    cleaned = cleaned.substring(0, cleaned.length - 1);
  }
  return cleaned;
}

/// Maps [Persistence] values to the wire modes accepted by the bridge worker.
String wirePersistenceMode(Persistence persistence) {
  if (persistence == Persistence.INDEXED_DB) {
    return 'LOCAL';
  }
  return persistence.name;
}

/// Unwraps a bridge auth subscription snapshot into a normalized user map.
Map<String, dynamic> normalizeBridgeSnapUserMap(Map<dynamic, dynamic> data) {
  final map = Map<String, dynamic>.from(
    data['user'] is Map ? data['user'] as Map : data,
  );
  if (data['claims'] != null && map['claims'] == null) {
    map['claims'] = data['claims'];
  }
  if (data['customClaims'] != null && map['customClaims'] == null) {
    map['customClaims'] = data['customClaims'];
  }
  return map;
}

/// Encodes an [AuthCredential] into the bridge `auth.signInWithCredential` wire payload.
Map<String, dynamic> buildCredentialWirePayload(AuthCredential credential) {
  final credMap = credential.asMap();
  final normalizedMethod =
      credential.signInMethod == 'oauth' && credential.providerId.isNotEmpty
          ? credential.providerId
          : credential.signInMethod;
  return <String, dynamic>{
    'providerId': credential.providerId,
    'signInMethod': normalizedMethod,
    if (credMap['idToken'] != null) 'idToken': credMap['idToken'],
    if (credMap['accessToken'] != null) 'accessToken': credMap['accessToken'],
    if (credMap['rawNonce'] != null) 'rawNonce': credMap['rawNonce'],
    if (credMap['email'] != null) 'email': credMap['email'],
    if (credMap['secret'] != null && credential.signInMethod == 'password')
      'password': credMap['secret'],
  };
}

/// Encodes a staged identity payload for `auth.mockSignInResult`.
Map<String, dynamic> buildMockSignInIdentityPayload({
  required String uid,
  required String providerId,
  String? email,
  String? displayName,
  String? photoURL,
  bool? emailVerified,
  Map<String, dynamic>? customClaims,
}) {
  return <String, dynamic>{
    'identity': <String, dynamic>{
      'uid': uid,
      'providerId': providerId,
      'email': email,
      'displayName': displayName,
      'photoURL': photoURL,
      'customClaims': customClaims ?? const <String, dynamic>{},
      if (emailVerified != null) 'emailVerified': emailVerified,
    },
  };
}
