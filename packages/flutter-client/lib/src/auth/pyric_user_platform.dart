import 'dart:async';

import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';

import '../transport/bridge_auth_operations.dart';
import '../transport/bridge_client.dart';
import 'pyric_multi_factor_platform.dart';

/// Concrete [UserPlatform] representing an authenticated user in Pyric.
class PyricUserPlatform extends UserPlatform {
  final PyricBridgeClient _client;

  /// Custom claims associated with this user identity.
  Map<String, dynamic>? customClaims;

  PyricUserPlatform._(
    super.auth,
    super.multiFactor,
    super.user,
    this._client,
  );

  static int? _parseTimestamp(dynamic val) {
    if (val == null) return null;
    if (val is num) return val.toInt();
    if (val is String) {
      final parsed = DateTime.tryParse(val);
      if (parsed != null) return parsed.millisecondsSinceEpoch;
      final asNum = num.tryParse(val);
      if (asNum != null) return asNum.toInt();
    }
    return null;
  }

  factory PyricUserPlatform.fromWire({
    required FirebaseAuthPlatform auth,
    required Map<String, dynamic> data,
    required PyricBridgeClient client,
  }) {
    final rawClaims = data['customClaims'] ??
        data['claims'] ??
        (data['token'] is Map ? data['token'] : null);
    final claims = rawClaims is Map
        ? Map<String, dynamic>.from(rawClaims)
        : null;
    final userInfo = InternalUserInfo(
      uid: data['uid'] as String,
      email: data['email'] as String?,
      displayName: data['displayName'] as String?,
      photoUrl: data['photoURL'] as String?,
      phoneNumber: data['phoneNumber'] as String?,
      isAnonymous: data['isAnonymous'] as bool? ?? false,
      isEmailVerified: data['emailVerified'] as bool? ?? false,
      providerId: data['providerId'] as String? ?? 'firebase',
      tenantId: data['tenantId'] as String?,
      refreshToken: data['refreshToken'] as String?,
      creationTimestamp:
          _parseTimestamp(data['creationTimestamp'] ?? data['createdAt']),
      lastSignInTimestamp:
          _parseTimestamp(data['lastSignInTimestamp'] ?? data['lastLoginAt']),
    );

    final rawProviders = data['providerData'] as List<dynamic>? ?? const [];
    final providerData = rawProviders.whereType<Map>().map((m) {
      final map = Map<Object?, Object?>.from(m);
      map['uid'] ??= data['uid'];
      map['isAnonymous'] = map['isAnonymous'] as bool? ?? false;
      map['isEmailVerified'] = map['isEmailVerified'] as bool? ?? false;
      map['photoUrl'] ??= map['photoURL'];
      return map;
    }).toList();

    final details = InternalUserDetails(
      userInfo: userInfo,
      providerData: providerData,
    );

    final user = PyricUserPlatform._(
      auth,
      PyricMultiFactorPlatform(auth),
      details,
      client,
    );
    user.customClaims = claims;
    return user;
  }

  factory PyricUserPlatform.fromUserDetails({
    required FirebaseAuthPlatform auth,
    required InternalUserDetails details,
    required PyricBridgeClient client,
  }) {
    return PyricUserPlatform._(
      auth,
      PyricMultiFactorPlatform(auth),
      details,
      client,
    );
  }

  @override
  Future<String?> getIdToken([bool forceRefresh = false]) async {
    return _client.authGetIdToken(forceRefresh: forceRefresh);
  }

  @override
  Future<IdTokenResult> getIdTokenResult([bool forceRefresh = false]) async {
    final res = await _client.authGetIdTokenResult(forceRefresh: forceRefresh);
    final claimsMap = (res['claims'] as Map?)?.cast<String, dynamic>();
    if (claimsMap != null) {
      customClaims = claimsMap;
      if (forceRefresh) {
        auth.sendAuthChangesEvent(auth.app.name, this);
      }
    }
    return IdTokenResult(InternalIdTokenResult(
      token: res['token'] as String?,
      expirationTimestamp: _parseTimestamp(res['expirationTime']),
      authTimestamp: _parseTimestamp(res['authTime']),
      issuedAtTimestamp: _parseTimestamp(res['issuedAtTime']),
      signInProvider: res['signInProvider'] as String?,
      claims: (res['claims'] as Map?)?.cast<String?, Object?>(),
    ));
  }

  @override
  Future<void> updateProfile(Map<String, String?> profile) async {
    final res = await _client.authUpdateProfile(
      displayName: profile['displayName'],
      photoURL: profile['photoURL'],
    );
    if (res is Map) {
      final updated = PyricUserPlatform.fromWire(
        auth: auth,
        data: Map<String, dynamic>.from(res),
        client: _client,
      );
      auth.currentUser = updated;
      auth.sendAuthChangesEvent(auth.app.name, updated);
    }
  }

  @override
  Future<void> reload() async {
    final res = await _client.authGetCurrentUser();
    if (res is Map) {
      final updated = PyricUserPlatform.fromWire(
        auth: auth,
        data: Map<String, dynamic>.from(res),
        client: _client,
      );
      auth.currentUser = updated;
      auth.sendAuthChangesEvent(auth.app.name, updated);
    }
  }

  @override
  Future<void> delete() async {
    await _client.op('auth.deleteUser', {});
    auth.currentUser = null;
    auth.sendAuthChangesEvent(auth.app.name, null);
  }
}
