import 'dart:async';

import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';
import 'package:firebase_core/firebase_core.dart';

import '../transport/bridge_auth_operations.dart';
import '../transport/bridge_client.dart';
import 'auth_lens.dart';
import 'auth_observer_reconciler.dart';
import 'auth_stream_hub.dart';
import 'auth_wire_codec.dart';
import 'pyric_auth_credentials_provider.dart';
import 'pyric_user_credential_platform.dart';
import 'pyric_user_platform.dart';

/// Concrete [FirebaseAuthPlatform] implementing pure-Dart authentication over the Pyric bridge.
class PyricFirebaseAuthPlatform extends FirebaseAuthPlatform
    implements PyricAuthCredentialsProvider {
  PyricBridgeClient _bridgeClient;
  bool _ownsBridgeClient;
  UserPlatform? _currentUser;
  AuthLens? _impersonatedLens;
  final AuthObserverReconciler _reconciler = AuthObserverReconciler();
  late final AuthStreamHub _streams;

  StreamSubscription<dynamic>? _bridgeAuthSub;
  StreamSubscription<dynamic>? _bridgeIdTokenSub;
  StreamSubscription<AuthLens>? _remoteLensSub;
  StreamSubscription<BridgeConnectionState>? _bridgeStateSub;

  String? _tenantId;
  String? _languageCode;
  String? _emulatorHost;
  int? _emulatorPort;

  PyricFirebaseAuthPlatform({
    super.appInstance,
    PyricBridgeClient? bridgeClient,
  })  : _bridgeClient = bridgeClient ?? PyricBridgeClient(),
        _ownsBridgeClient = bridgeClient == null {
    _streams = AuthStreamHub(
      readCurrentUser: () => _currentUser,
      readCurrentLens: () => currentAuthLens,
    );
    _initBridgeAuthListeners();
  }

  /// Access the underlying Pyric bridge client.
  PyricBridgeClient get bridgeClient => _bridgeClient;

  bool get _isLiveBridge => _bridgeClient.channelFactory == null;

  /// Registers [PyricFirebaseAuthPlatform] as the default platform instance.
  static void registerWith({PyricBridgeClient? bridgeClient}) {
    FirebaseAuthPlatform.instance = PyricFirebaseAuthPlatform(
      bridgeClient: bridgeClient,
    );
  }

  @override
  FirebaseAuthPlatform delegateFor({required FirebaseApp app}) {
    return PyricFirebaseAuthPlatform(
      appInstance: app,
      bridgeClient: _bridgeClient,
    );
  }

  @override
  FirebaseAuthPlatform setInitialValues({
    String? languageCode,
    InternalUserDetails? currentUser,
  }) {
    if (languageCode != null) _languageCode = languageCode;
    if (currentUser != null) {
      _currentUser = PyricUserPlatform.fromUserDetails(
        auth: this,
        details: currentUser,
        client: _bridgeClient,
      );
      _streams.seedInitial(uid: _currentUser?.uid, lens: currentAuthLens);
    }
    return this;
  }

  int beginLocalAuthMutation() => _reconciler.beginLocalMutation();

  void endLocalAuthMutation() => _reconciler.endLocalMutation();

  void notifyUserMutation(
    PyricUserPlatform user, {
    required bool tokenChanged,
    int? mutationSeq,
  }) {
    if (mutationSeq != null && !_reconciler.tryClaimMutation(mutationSeq)) {
      return;
    }
    final prevUid = _currentUser?.uid;
    _currentUser = user;
    _reconciler.recordLocalTransition(
      prevUid: prevUid,
      nextUid: user.uid,
      authStateChanged: prevUid != user.uid,
      tokenChanged: tokenChanged,
    );
    _streams.emitAuthStateIfChanged(user);
    if (tokenChanged) _streams.emitIdToken(user);
    _streams.emitUserChanges(user);
    _streams.emitLensIfChanged();
  }

  void invalidateCurrentUserIfMatches(String uid, {int? mutationSeq}) {
    if (mutationSeq != null && !_reconciler.tryClaimMutation(mutationSeq)) {
      return;
    }
    if (_currentUser != null && _currentUser?.uid != uid) return;
    final prevUid = _currentUser?.uid;
    _currentUser = null;
    _reconciler.recordLocalTransition(
      prevUid: prevUid,
      nextUid: null,
      authStateChanged: true,
      tokenChanged: true,
    );
    _streams.emitAuthStateIfChanged(null);
    _streams.emitIdToken(null);
    _streams.emitUserChanges(null);
    _streams.emitLensIfChanged();
  }

  PyricUserPlatform _buildWireUserPreservingPrev(Map<String, dynamic> map) {
    final prev = _currentUser;
    if (prev is PyricUserPlatform && prev.uid == map['uid']) {
      map['creationTimestamp'] ??= prev.creationTimestampMillis;
      map['lastSignInTimestamp'] ??= prev.lastSignInTimestampMillis;
    }
    final user = PyricUserPlatform.fromWire(
      auth: this,
      data: map,
      client: _bridgeClient,
    );
    if (prev is PyricUserPlatform && prev.uid == user.uid) {
      user.customClaims ??= prev.customClaims;
      user.liveJwtTokenClaims ??= prev.liveJwtTokenClaims;
      user.tenantId ??= prev.tenantId;
    }
    return user;
  }

  void _applyObserverSnap(dynamic data, {required bool isAuthState}) {
    if (data != null && data is! Map) return;
    final normalized =
        data is Map ? normalizeBridgeSnapUserMap(data) : null;
    final snapUid = normalized?['uid'] as String?;
    final shouldApply = isAuthState
        ? _reconciler.shouldApplyAuthStateSnap(snapUid)
        : _reconciler.shouldApplyIdTokenSnap(snapUid);
    if (!shouldApply) return;

    if (normalized == null) {
      if (_currentUser == null && _streams.lastAuthStateUid == null) return;
      _currentUser = null;
    } else {
      _currentUser = _buildWireUserPreservingPrev(normalized);
    }

    if (isAuthState) {
      _streams.emitAuthStateIfChanged(_currentUser);
    } else {
      _streams.emitIdToken(_currentUser);
    }
    _streams.emitUserChanges(_currentUser);
    _streams.emitLensIfChanged();
  }

  void _initBridgeAuthListeners() {
    if (_bridgeClient.isDisposed) {
      _streams.closeAllSync();
      return;
    }

    _bridgeAuthSub = _bridgeClient.subscribeRaw({'target': 'authState'}).listen(
      (data) => _applyObserverSnap(data, isAuthState: true),
      onError: (Object err) =>
          _streams.addAuthStateError(mapBridgeAuthError(err)),
      onDone: _streams.closeAuthState,
    );

    _bridgeIdTokenSub =
        _bridgeClient.subscribeRaw({'target': 'idToken'}).listen(
      (data) => _applyObserverSnap(data, isAuthState: false),
      onError: (Object err) =>
          _streams.addIdTokenError(mapBridgeAuthError(err)),
      onDone: _streams.closeIdToken,
    );

    _remoteLensSub = _bridgeClient.remoteLensStream.listen(
      switchAuthLens,
      onError: (Object _, StackTrace __) {},
    );

    _bridgeStateSub = _bridgeClient.connectionStates.listen(
      (state) {
        if (state == BridgeConnectionState.interrupted) {
          _reconciler.resetEchoes();
        }
      },
      onDone: _streams.closeAllSync,
    );

    _bridgeClient.restoreAuth = (op) async {
      final user = _currentUser;
      if (user == null) return;
      await op('auth.restorePortSession', {
        'uid': user.uid,
        'tenantId': user.tenantId,
      });
    };
  }

  @override
  UserPlatform? get currentUser => _currentUser;

  @override
  set currentUser(UserPlatform? userPlatform) {
    _currentUser = userPlatform;
    _streams.setLastAuthStateUid(userPlatform?.uid);
    _reconciler.resetEchoes();
    _streams.emitLensIfChanged();
  }

  @override
  String? get tenantId => _tenantId;

  @override
  set tenantId(String? value) {
    _tenantId = value;
    _streams.emitLensIfChanged();
  }

  Future<void> setTenantId(String? tenantId) async {
    _tenantId = tenantId;
    _streams.emitLensIfChanged();
  }

  @override
  String? get languageCode => _languageCode;

  @override
  Future<void> setLanguageCode(String? languageCode) async {
    _languageCode = languageCode;
  }

  String? get emulatorHost => _emulatorHost;

  int? get emulatorPort => _emulatorPort;

  @override
  Future<void> useAuthEmulator(String host, int port) async {
    _emulatorHost = host;
    _emulatorPort = port;
    if (!_isLiveBridge) return;
    final cleanHost = sanitizeEmulatorHost(host);
    await _cancelBridgeSubscriptions();
    if (_ownsBridgeClient) await _bridgeClient.disconnect();
    _bridgeClient = PyricBridgeClient(
      uri: Uri.parse('ws://$cleanHost:$port/__pyric/sandbox'),
      headers: <String, dynamic>{'Host': '$cleanHost:$port'},
    );
    _ownsBridgeClient = true;
    _reconciler.resetEchoes();
    _initBridgeAuthListeners();
    await _bridgeClient.connect();
  }

  Future<void> _cancelBridgeSubscriptions() async {
    final authSub = _bridgeAuthSub;
    _bridgeAuthSub = null;
    final idTokenSub = _bridgeIdTokenSub;
    _bridgeIdTokenSub = null;
    final remoteSub = _remoteLensSub;
    _remoteLensSub = null;
    final stateSub = _bridgeStateSub;
    _bridgeStateSub = null;
    await authSub?.cancel();
    await idTokenSub?.cancel();
    await remoteSub?.cancel();
    await stateSub?.cancel();
  }

  @override
  Future<void> setPersistence(Persistence persistence) async {
    try {
      await _bridgeClient.authSetPersistence(wirePersistenceMode(persistence));
    } catch (e) {
      throw mapBridgeAuthError(e);
    }
  }

  /// Stages a resolved OAuth identity on the sandbox port for the next
  /// `signInWithCredential` call matching [providerId].
  Future<void> stageSignInResult({
    required String uid,
    required String providerId,
    String? email,
    String? displayName,
    String? photoURL,
    bool? emailVerified,
    Map<String, dynamic>? customClaims,
  }) async {
    try {
      await _bridgeClient.op(
        'auth.mockSignInResult',
        buildMockSignInIdentityPayload(
          uid: uid,
          providerId: providerId,
          email: email,
          displayName: displayName,
          photoURL: photoURL,
          emailVerified: emailVerified,
          customClaims: customClaims,
        ),
      );
    } catch (e) {
      throw mapBridgeAuthError(e);
    }
  }

  @override
  void sendAuthChangesEvent(String appName, UserPlatform? userPlatform) {
    _currentUser = userPlatform;
    _reconciler.resetEchoes();
    _streams.emitAuthStateForced(userPlatform);
    _streams.emitIdToken(userPlatform);
    _streams.emitUserChanges(userPlatform);
    _streams.emitLensIfChanged();
  }

  @override
  Stream<UserPlatform?> authStateChanges() => _streams.authStateChanges();

  @override
  Stream<UserPlatform?> idTokenChanges() => _streams.idTokenChanges();

  @override
  Stream<UserPlatform?> userChanges() => _streams.userChanges();

  AuthLens _lensForUser(UserPlatform? user) {
    if (user == null) return AuthLens.anon;
    Map<String, dynamic>? lensToken;
    if (user is PyricUserPlatform) {
      if (_isLiveBridge && user.liveJwtTokenClaims != null) {
        lensToken = user.liveJwtTokenClaims;
      } else if (user.customClaims != null && user.customClaims!.isNotEmpty) {
        lensToken = user.customClaims;
      }
    }
    return AuthLens.asUser(
      uid: user.uid,
      tenant: user.tenantId ?? _tenantId,
      token: lensToken,
    );
  }

  /// Switches active auth lens, or clears impersonation if null.
  void switchAuthLens(AuthLens? lens) {
    _impersonatedLens = lens;
    _streams.emitLensIfChanged();
  }

  @override
  AuthLens get currentAuthLens =>
      _impersonatedLens ?? _lensForUser(_currentUser);

  @override
  Stream<AuthLens> get authLensChanges => _streams.authLensChanges;

  Future<UserCredentialPlatform> _completeSignInResponse(
    Map<dynamic, dynamic> res, {
    required bool defaultIsNewUser,
    required int mutationSeq,
    String? fallbackProviderId,
  }) async {
    final userMap = normalizeBridgeSnapUserMap(res);
    if (_tenantId != null && userMap['tenantId'] == null) {
      userMap['tenantId'] = _tenantId;
    }
    if (_isLiveBridge) {
      final tokenRes =
          await _bridgeClient.authGetIdTokenResult(forceRefresh: false);
      final rawClaims = tokenRes['claims'] is Map
          ? Map<String, dynamic>.from(tokenRes['claims'] as Map)
          : null;
      if (rawClaims != null) {
        userMap['liveJwtTokenClaims'] = rawClaims;
        final extracted = extractCustomClaimsFromJwtClaims(rawClaims);
        if (extracted != null && userMap['customClaims'] == null) {
          userMap['customClaims'] = extracted;
        }
      }
      final authTs = parseWireTimestampMillis(tokenRes['authTime']) ??
          parseWireTimestampMillis(tokenRes['issuedAtTime']);
      if (authTs != null) {
        userMap['creationTimestamp'] ??= authTs;
        userMap['lastSignInTimestamp'] ??= authTs;
      }
    }
    final user = PyricUserPlatform.fromWire(
      auth: this,
      data: userMap,
      client: _bridgeClient,
    );
    if (_reconciler.tryClaimMutation(mutationSeq)) {
      final prevUid = _currentUser?.uid;
      _currentUser = user;
      _reconciler.recordLocalTransition(
        prevUid: prevUid,
        nextUid: user.uid,
        authStateChanged: true,
        tokenChanged: true,
      );
      _streams.emitAuthStateIfChanged(user);
      _streams.emitIdToken(user);
      _streams.emitUserChanges(user);
      _streams.emitLensIfChanged();
    }
    final addInfo = res['additionalUserInfo'] as Map?;
    final isNewUser = addInfo != null
        ? (addInfo['isNewUser'] as bool? ?? defaultIsNewUser)
        : defaultIsNewUser;
    final providerId = fallbackProviderId ??
        (addInfo != null
            ? addInfo['providerId'] as String?
            : res['providerId'] as String?);
    return PyricUserCredentialPlatform(
      auth: this,
      user: user,
      additionalUserInfo: AdditionalUserInfo(
        isNewUser: isNewUser,
        providerId: providerId,
      ),
    );
  }

  Future<UserCredentialPlatform> _runSignInOp(
    Future<dynamic> Function() rpc, {
    required bool defaultIsNewUser,
    String? fallbackProviderId,
  }) async {
    final seq = beginLocalAuthMutation();
    try {
      final res = await rpc();
      return await _completeSignInResponse(
        res as Map,
        defaultIsNewUser: defaultIsNewUser,
        mutationSeq: seq,
        fallbackProviderId: fallbackProviderId,
      );
    } catch (e) {
      throw mapBridgeAuthError(e);
    } finally {
      endLocalAuthMutation();
    }
  }

  @override
  Future<UserCredentialPlatform> signInWithEmailAndPassword(
    String email,
    String password,
  ) =>
      _runSignInOp(
        () => _bridgeClient.authSignInEmail(email, password, tenantId: _tenantId),
        defaultIsNewUser: false,
      );

  @override
  Future<UserCredentialPlatform> createUserWithEmailAndPassword(
    String email,
    String password,
  ) =>
      _runSignInOp(
        () => _bridgeClient.authCreateUser(email, password, tenantId: _tenantId),
        defaultIsNewUser: true,
      );

  @override
  Future<UserCredentialPlatform> signInAnonymously() => _runSignInOp(
        () => _bridgeClient.authSignInAnonymously(tenantId: _tenantId),
        defaultIsNewUser: true,
      );

  @override
  Future<UserCredentialPlatform> signInWithCredential(
    AuthCredential credential,
  ) =>
      _runSignInOp(
        () => _bridgeClient.authSignInWithCredential(
          buildCredentialWirePayload(credential),
          tenantId: _tenantId,
        ),
        defaultIsNewUser: false,
        fallbackProviderId: credential.providerId,
      );

  @override
  Future<UserCredentialPlatform> signInWithCustomToken(String token) =>
      _runSignInOp(
        () => _bridgeClient.op('auth.signInWithCustomToken', <String, dynamic>{
          'customToken': token,
          if (_tenantId != null) 'tenantId': _tenantId,
        }),
        defaultIsNewUser: false,
      );

  @override
  Future<void> signOut() async {
    final seq = beginLocalAuthMutation();
    try {
      await _bridgeClient.authSignOut();
      if (_reconciler.tryClaimMutation(seq)) {
        final prevUid = _currentUser?.uid;
        _currentUser = null;
        _reconciler.recordLocalTransition(
          prevUid: prevUid,
          nextUid: null,
          authStateChanged: true,
          tokenChanged: true,
        );
        _streams.emitAuthStateIfChanged(null);
        _streams.emitIdToken(null);
        _streams.emitUserChanges(null);
        _streams.emitLensIfChanged();
      }
    } catch (e) {
      throw mapBridgeAuthError(e);
    } finally {
      endLocalAuthMutation();
    }
  }

  @override
  Future<void> dispose() async {
    await _cancelBridgeSubscriptions();
    if (_ownsBridgeClient) await _bridgeClient.disconnect();
    await _streams.dispose();
  }
}
