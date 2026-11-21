import 'dart:async';

import 'package:async/async.dart';
import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';
import 'package:firebase_core/firebase_core.dart';

import '../transport/bridge_auth_operations.dart';
import '../transport/bridge_client.dart';
import 'auth_lens.dart';
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
  String? _lastAuthStateUid;
  int _pendingLocalAuthMutations = 0;

  final StreamController<UserPlatform?> _authStateController =
      StreamController<UserPlatform?>.broadcast();
  final StreamController<UserPlatform?> _idTokenController =
      StreamController<UserPlatform?>.broadcast();
  final StreamController<UserPlatform?> _userChangesController =
      StreamController<UserPlatform?>.broadcast();

  StreamSubscription<dynamic>? _bridgeAuthSub;
  StreamSubscription<dynamic>? _bridgeIdTokenSub;
  StreamSubscription<AuthLens>? _remoteLensSub;

  AuthLens? _impersonatedLens;
  final StreamController<AuthLens> _lensController =
      StreamController<AuthLens>.broadcast();

  String? _tenantId;
  String? _languageCode;
  String? _emulatorHost;
  int? _emulatorPort;

  PyricFirebaseAuthPlatform({
    super.appInstance,
    PyricBridgeClient? bridgeClient,
  })  : _bridgeClient = bridgeClient ?? PyricBridgeClient(),
        _ownsBridgeClient = bridgeClient == null {
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
    return PyricFirebaseAuthPlatform(appInstance: app, bridgeClient: _bridgeClient);
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
      _lastAuthStateUid = _currentUser?.uid;
    }
    return this;
  }

  void beginLocalAuthMutation() => _pendingLocalAuthMutations += 1;

  void endLocalAuthMutation() {
    if (_pendingLocalAuthMutations > 0) _pendingLocalAuthMutations -= 1;
  }

  void _emitAuthStateIfChanged(UserPlatform? user) {
    final nextUid = user?.uid;
    if (nextUid != _lastAuthStateUid) {
      _lastAuthStateUid = nextUid;
      _authStateController.add(user);
    }
  }

  void notifyUserMutation(PyricUserPlatform user, {required bool tokenChanged}) {
    _currentUser = user;
    _emitAuthStateIfChanged(user);
    if (tokenChanged) _idTokenController.add(user);
    _userChangesController.add(user);
  }

  void invalidateCurrentUserIfMatches(String uid) {
    if (_currentUser != null && _currentUser?.uid != uid) return;
    _currentUser = null;
    _emitAuthStateIfChanged(null);
    _idTokenController.add(null);
    _userChangesController.add(null);
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

  void _initBridgeAuthListeners() {
    _bridgeAuthSub = _bridgeClient.subscribeRaw({'target': 'authState'}).listen(
      (data) {
        if (_pendingLocalAuthMutations > 0) return;
        if (data == null) {
          if (_currentUser == null && _lastAuthStateUid == null) return;
          _currentUser = null;
          _emitAuthStateIfChanged(null);
          _userChangesController.add(null);
        } else if (data is Map) {
          _currentUser = _buildWireUserPreservingPrev(
            normalizeBridgeSnapUserMap(data),
          );
          _emitAuthStateIfChanged(_currentUser);
          _userChangesController.add(_currentUser);
        }
      },
      onError: (Object err) => _authStateController.addError(mapBridgeAuthError(err)),
    );

    _bridgeIdTokenSub =
        _bridgeClient.subscribeRaw({'target': 'idToken'}).listen(
      (data) {
        if (_pendingLocalAuthMutations > 0) return;
        if (data == null) {
          if (_currentUser == null && _lastAuthStateUid == null) return;
          _currentUser = null;
          _idTokenController.add(null);
          _userChangesController.add(null);
        } else if (data is Map) {
          _currentUser = _buildWireUserPreservingPrev(
            normalizeBridgeSnapUserMap(data),
          );
          _idTokenController.add(_currentUser);
          _userChangesController.add(_currentUser);
        }
      },
      onError: (Object err) => _idTokenController.addError(mapBridgeAuthError(err)),
    );

    _remoteLensSub = _bridgeClient.remoteLensStream.listen(switchAuthLens);
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
    _lastAuthStateUid = userPlatform?.uid;
  }

  @override
  String? get tenantId => _tenantId;

  @override
  set tenantId(String? value) => _tenantId = value;

  Future<void> setTenantId(String? tenantId) async {
    _tenantId = tenantId;
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
    await _bridgeAuthSub?.cancel();
    _bridgeAuthSub = null;
    await _bridgeIdTokenSub?.cancel();
    _bridgeIdTokenSub = null;
    await _remoteLensSub?.cancel();
    _remoteLensSub = null;
    if (_ownsBridgeClient) await _bridgeClient.disconnect();
    _bridgeClient = PyricBridgeClient(
      uri: Uri.parse('ws://$cleanHost:$port/__pyric/sandbox'),
      headers: <String, dynamic>{'Host': '$cleanHost:$port'},
    );
    _ownsBridgeClient = true;
    _initBridgeAuthListeners();
    await _bridgeClient.connect();
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
    _lastAuthStateUid = userPlatform?.uid;
    _authStateController.add(userPlatform);
    _idTokenController.add(userPlatform);
    _userChangesController.add(userPlatform);
  }

  Stream<UserPlatform?> _createReplayingStream(Stream<UserPlatform?> source) {
    return Stream<UserPlatform?>.multi((controller) {
      controller.add(_currentUser);
      final sub = source.listen(
        controller.add,
        onError: controller.addError,
        onDone: controller.close,
      );
      controller.onCancel = () => sub.cancel();
    }, isBroadcast: true);
  }

  @override
  Stream<UserPlatform?> authStateChanges() =>
      _createReplayingStream(_authStateController.stream);

  @override
  Stream<UserPlatform?> idTokenChanges() =>
      _createReplayingStream(_idTokenController.stream);

  @override
  Stream<UserPlatform?> userChanges() =>
      _createReplayingStream(_userChangesController.stream);

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
    _lensController.add(currentAuthLens);
  }

  @override
  AuthLens get currentAuthLens =>
      _impersonatedLens ?? _lensForUser(_currentUser);

  @override
  Stream<AuthLens> get authLensChanges {
    return StreamGroup.merge([
      authStateChanges().map(_lensForUser),
      idTokenChanges().map(_lensForUser),
      _lensController.stream,
    ]).distinct();
  }

  Future<UserCredentialPlatform> _completeSignInResponse(
    Map<dynamic, dynamic> res, {
    required bool defaultIsNewUser,
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
    _currentUser = user;
    _emitAuthStateIfChanged(user);
    _idTokenController.add(user);
    _userChangesController.add(user);
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
    beginLocalAuthMutation();
    try {
      final res = await rpc();
      return await _completeSignInResponse(
        res as Map,
        defaultIsNewUser: defaultIsNewUser,
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
    beginLocalAuthMutation();
    try {
      await _bridgeClient.authSignOut();
      _currentUser = null;
      _emitAuthStateIfChanged(null);
      _idTokenController.add(null);
      _userChangesController.add(null);
    } catch (e) {
      throw mapBridgeAuthError(e);
    } finally {
      endLocalAuthMutation();
    }
  }

  @override
  Future<void> dispose() async {
    await _bridgeAuthSub?.cancel();
    _bridgeAuthSub = null;
    await _bridgeIdTokenSub?.cancel();
    _bridgeIdTokenSub = null;
    await _remoteLensSub?.cancel();
    _remoteLensSub = null;
    if (_ownsBridgeClient) await _bridgeClient.disconnect();
    await _lensController.close();
    await _authStateController.close();
    await _idTokenController.close();
    await _userChangesController.close();
  }
}
