import 'dart:async';

import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';

import '../transport/bridge_auth_operations.dart';
import '../transport/bridge_client.dart';
import 'auth_wire_codec.dart';
import 'pyric_firebase_auth_platform.dart';
import 'pyric_multi_factor_platform.dart';

/// Concrete [UserPlatform] representing an authenticated user in Pyric.
class PyricUserPlatform extends UserPlatform {
  final PyricBridgeClient _client;
  final int? _creationTimestampMs;
  final int? _lastSignInTimestampMs;

  /// Custom developer claims associated with this user identity.
  Map<String, dynamic>? customClaims;

  /// Full decoded JWT claims captured from a live bridge session for Security Rules evaluation.
  Map<String, dynamic>? liveJwtTokenClaims;

  String? _tenantId;

  @override
  String? get tenantId => _tenantId ?? super.tenantId;

  set tenantId(String? value) => _tenantId = value;

  int? get creationTimestampMillis => _creationTimestampMs;

  int? get lastSignInTimestampMillis => _lastSignInTimestampMs;

  PyricUserPlatform._(
    super.auth,
    super.multiFactor,
    super.user,
    this._client,
    this._creationTimestampMs,
    this._lastSignInTimestampMs,
  );

  PyricFirebaseAuthPlatform? get _pyricAuth =>
      auth is PyricFirebaseAuthPlatform
          ? auth as PyricFirebaseAuthPlatform
          : null;

  bool get _isLiveBridge => _client.channelFactory == null;

  factory PyricUserPlatform.fromWire({
    required FirebaseAuthPlatform auth,
    required Map<String, dynamic> data,
    required PyricBridgeClient client,
  }) {
    final rawClaims = data['customClaims'] ??
        data['claims'] ??
        (data['token'] is Map ? data['token'] : null);
    final claims = rawClaims is Map
        ? extractCustomClaimsFromJwtClaims(rawClaims)
        : null;
    final creationTs = parseWireTimestampMillis(
      data['creationTimestamp'] ?? data['createdAt'],
    );
    final lastSignInTs = parseWireTimestampMillis(
      data['lastSignInTimestamp'] ?? data['lastLoginAt'],
    );
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
      creationTimestamp: creationTs,
      lastSignInTimestamp: lastSignInTs,
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
      creationTs,
      lastSignInTs,
    );
    user.customClaims = claims;
    if (data['liveJwtTokenClaims'] is Map) {
      user.liveJwtTokenClaims =
          Map<String, dynamic>.from(data['liveJwtTokenClaims'] as Map);
    }
    user.tenantId = data['tenantId'] as String?;
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
      details.userInfo.creationTimestamp,
      details.userInfo.lastSignInTimestamp,
    );
  }

  Future<T> _runGuardedUserOp<T>(
    Future<T> Function(int? mutationSeq) action, {
    bool mutatesState = true,
  }) async {
    final owner = _pyricAuth;
    final seq = mutatesState
        ? owner?.beginLocalAuthMutation()
        : owner?.allocateLocalAuthMutationSeq();
    try {
      return await action(seq);
    } catch (error) {
      final mapped = mapBridgeAuthError(error);
      if (mapped is FirebaseAuthException &&
          isAccountInvalidatingAuthCode(mapped.code)) {
        owner?.invalidateCurrentUserIfMatches(uid, mutationSeq: seq);
      }
      throw mapped;
    } finally {
      if (mutatesState) {
        owner?.endLocalAuthMutation();
      }
    }
  }

  @override
  Future<String?> getIdToken([bool forceRefresh = false]) {
    return _runGuardedUserOp((seq) async {
      final token = await _client.authGetIdToken(forceRefresh: forceRefresh);
      if (forceRefresh && _isLiveBridge) {
        final tokenRes =
            await _client.authGetIdTokenResult(forceRefresh: false);
        final rawClaims = tokenRes['claims'] is Map
            ? Map<String, dynamic>.from(tokenRes['claims'] as Map)
            : null;
        customClaims = extractCustomClaimsFromJwtClaims(rawClaims);
        if (rawClaims != null) {
          liveJwtTokenClaims = rawClaims;
        }
        _pyricAuth?.notifyUserMutation(
          this,
          tokenChanged: true,
          mutationSeq: seq,
        );
      } else if (forceRefresh) {
        _pyricAuth?.notifyUserMutation(
          this,
          tokenChanged: true,
          mutationSeq: seq,
        );
      }
      return token;
    }, mutatesState: forceRefresh);
  }

  @override
  Future<IdTokenResult> getIdTokenResult([bool forceRefresh = false]) {
    return _runGuardedUserOp((seq) async {
      final res =
          await _client.authGetIdTokenResult(forceRefresh: forceRefresh);
      final rawClaims = res['claims'] is Map
          ? Map<String, dynamic>.from(res['claims'] as Map)
          : null;
      if (rawClaims != null) {
        customClaims = extractCustomClaimsFromJwtClaims(rawClaims);
        if (_isLiveBridge) {
          liveJwtTokenClaims = rawClaims;
        }
        if (forceRefresh) {
          final owner = _pyricAuth;
          if (owner != null) {
            owner.notifyUserMutation(
              this,
              tokenChanged: true,
              mutationSeq: seq,
            );
          } else {
            auth.sendAuthChangesEvent(auth.app.name, this);
          }
        }
      }
      return IdTokenResult(InternalIdTokenResult(
        token: res['token'] as String?,
        expirationTimestamp: parseWireTimestampMillis(res['expirationTime']),
        authTimestamp: parseWireTimestampMillis(res['authTime']),
        issuedAtTimestamp: parseWireTimestampMillis(res['issuedAtTime']),
        signInProvider: res['signInProvider'] as String?,
        claims: (res['claims'] as Map?)?.cast<String?, Object?>(),
      ));
    }, mutatesState: forceRefresh);
  }

  Future<void> _applyUpdatedUser(
    Map<String, dynamic> res, {
    required bool tokenChanged,
    int? mutationSeq,
    bool refreshLiveJwtClaims = false,
  }) async {
    final merged = Map<String, dynamic>.from(res);
    if (merged['creationTimestamp'] == null && _creationTimestampMs != null) {
      merged['creationTimestamp'] = _creationTimestampMs;
    }
    if (merged['lastSignInTimestamp'] == null &&
        _lastSignInTimestampMs != null) {
      merged['lastSignInTimestamp'] = _lastSignInTimestampMs;
    }
    final updated = PyricUserPlatform.fromWire(
      auth: auth,
      data: merged,
      client: _client,
    );
    if (updated.customClaims == null && customClaims != null) {
      updated.customClaims = customClaims;
    }
    if (updated.tenantId == null && tenantId != null) {
      updated.tenantId = tenantId;
    }
    if (_isLiveBridge && refreshLiveJwtClaims) {
      final tokenRes = await _client.authGetIdTokenResult(forceRefresh: false);
      final rawClaims = tokenRes['claims'] is Map
          ? Map<String, dynamic>.from(tokenRes['claims'] as Map)
          : null;
      if (rawClaims != null) {
        updated.liveJwtTokenClaims = rawClaims;
        updated.customClaims = extractCustomClaimsFromJwtClaims(rawClaims);
      }
    } else if (updated.liveJwtTokenClaims == null &&
        liveJwtTokenClaims != null) {
      updated.liveJwtTokenClaims = liveJwtTokenClaims;
    }
    final owner = _pyricAuth;
    if (owner != null) {
      owner.notifyUserMutation(
        updated,
        tokenChanged: tokenChanged,
        mutationSeq: mutationSeq,
      );
    } else {
      auth.currentUser = updated;
      auth.sendAuthChangesEvent(auth.app.name, updated);
    }
  }

  @override
  Future<void> updateProfile(Map<String, String?> profile) {
    return _runGuardedUserOp((seq) async {
      final res = await _client.op('auth.updateProfile', <String, dynamic>{
        if (profile.containsKey('displayName'))
          'displayName': profile['displayName'],
        if (profile.containsKey('photoURL')) 'photoURL': profile['photoURL'],
      });
      if (res is Map) {
        await _applyUpdatedUser(
          Map<String, dynamic>.from(res),
          tokenChanged: false,
          mutationSeq: seq,
        );
      }
    });
  }

  @override
  Future<void> updateEmail(String newEmail) {
    return _runGuardedUserOp((seq) async {
      final res = await _client.authUpdateEmail(newEmail);
      if (res is Map) {
        await _applyUpdatedUser(
          Map<String, dynamic>.from(res),
          tokenChanged: true,
          mutationSeq: seq,
          refreshLiveJwtClaims: true,
        );
      }
    });
  }

  @override
  Future<void> updatePassword(String newPassword) {
    return _runGuardedUserOp((seq) async {
      final res = await _client.authUpdatePassword(newPassword);
      if (res is Map) {
        await _applyUpdatedUser(
          Map<String, dynamic>.from(res),
          tokenChanged: true,
          mutationSeq: seq,
          refreshLiveJwtClaims: true,
        );
      }
    });
  }

  @override
  Future<void> reload() {
    return _runGuardedUserOp((seq) async {
      final res = _isLiveBridge
          ? await _client.op('auth.reload', <String, dynamic>{'uid': uid})
          : await _client.authGetCurrentUser();
      if (res is Map) {
        await _applyUpdatedUser(
          Map<String, dynamic>.from(res),
          tokenChanged: false,
          mutationSeq: seq,
        );
      }
    });
  }

  @override
  Future<void> delete() {
    return _runGuardedUserOp((seq) async {
      await _client.op('auth.deleteUser', <String, dynamic>{});
      final owner = _pyricAuth;
      if (owner != null) {
        owner.invalidateCurrentUserIfMatches(uid, mutationSeq: seq);
      } else {
        auth.currentUser = null;
        auth.sendAuthChangesEvent(auth.app.name, null);
      }
    });
  }
}
