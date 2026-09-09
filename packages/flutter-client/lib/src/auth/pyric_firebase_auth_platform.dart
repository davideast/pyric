import 'dart:async';

import 'package:async/async.dart';
import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';
import 'package:firebase_core/firebase_core.dart';

import '../transport/bridge_auth_operations.dart';
import '../transport/bridge_client.dart';
import 'auth_lens.dart';
import 'pyric_auth_credentials_provider.dart';
import 'pyric_user_credential_platform.dart';
import 'pyric_user_platform.dart';

/// Concrete [FirebaseAuthPlatform] implementing pure-Dart authentication over the Pyric bridge.
class PyricFirebaseAuthPlatform extends FirebaseAuthPlatform
    implements PyricAuthCredentialsProvider {
  final PyricBridgeClient _bridgeClient;
  UserPlatform? _currentUser;

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
  })  : _bridgeClient = bridgeClient ?? PyricBridgeClient() {
    _initBridgeAuthListeners();
  }

  /// Access the underlying Pyric bridge client.
  PyricBridgeClient get bridgeClient => _bridgeClient;

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
    if (currentUser != null) {
      _currentUser = PyricUserPlatform.fromUserDetails(
        auth: this,
        details: currentUser,
        client: _bridgeClient,
      );
    }
    return this;
  }

  void _preservePreviousUserMetadata(
    PyricUserPlatform user,
    UserPlatform? prev,
  ) {
    if (prev is PyricUserPlatform && prev.uid == user.uid) {
      if (user.customClaims == null && prev.customClaims != null) {
        user.customClaims = prev.customClaims;
      }
      if (user.tenantId == null && prev.tenantId != null) {
        user.tenantId = prev.tenantId;
      }
    }
  }

  void _initBridgeAuthListeners() {
    _bridgeAuthSub = _bridgeClient.subscribeRaw({'target': 'authState'}).listen(
      (data) {
        if (data == null) {
          _currentUser = null;
        } else if (data is Map) {
          final map = Map<String, dynamic>.from(
            data['user'] is Map ? data['user'] as Map : data,
          );
          if (data['claims'] != null && map['claims'] == null) {
            map['claims'] = data['claims'];
          }
          if (data['customClaims'] != null && map['customClaims'] == null) {
            map['customClaims'] = data['customClaims'];
          }
          final user = PyricUserPlatform.fromWire(
            auth: this,
            data: map,
            client: _bridgeClient,
          );
          _preservePreviousUserMetadata(user, _currentUser);
          _currentUser = user;
        }
        _authStateController.add(_currentUser);
        _userChangesController.add(_currentUser);
      },
      onError: (err) {
        _authStateController.addError(_mapAuthError(err));
      },
    );

    _bridgeIdTokenSub =
        _bridgeClient.subscribeRaw({'target': 'idToken'}).listen(
      (data) {
        if (data == null) {
          _currentUser = null;
        } else if (data is Map) {
          final map = Map<String, dynamic>.from(
            data['user'] is Map ? data['user'] as Map : data,
          );
          if (data['claims'] != null && map['claims'] == null) {
            map['claims'] = data['claims'];
          }
          if (data['customClaims'] != null && map['customClaims'] == null) {
            map['customClaims'] = data['customClaims'];
          }
          final user = PyricUserPlatform.fromWire(
            auth: this,
            data: map,
            client: _bridgeClient,
          );
          _preservePreviousUserMetadata(user, _currentUser);
          _currentUser = user;
        }
        _idTokenController.add(_currentUser);
        _userChangesController.add(_currentUser);
      },
      onError: (err) {
        _idTokenController.addError(_mapAuthError(err));
      },
    );

    _remoteLensSub = _bridgeClient.remoteLensStream.listen((lens) {
      switchAuthLens(lens);
    });
  }

  static Object _mapAuthError(dynamic error) {
    if (error is PyricBridgeException) {
      return FirebaseAuthException(
        code: error.code,
        message: error.message,
      );
    }
    return error;
  }

  @override
  UserPlatform? get currentUser => _currentUser;

  @override
  set currentUser(UserPlatform? userPlatform) {
    _currentUser = userPlatform;
  }

  @override
  String? get tenantId => _tenantId;

  @override
  set tenantId(String? value) {
    _tenantId = value;
  }

  @override
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
  }

  @override
  Future<void> setPersistence(Persistence persistence) async {
    await _bridgeClient.authSetPersistence(persistence.name);
  }

  @override
  void sendAuthChangesEvent(String appName, UserPlatform? userPlatform) {
    _currentUser = userPlatform;
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
    if (user == null) {
      return AuthLens.anon;
    }
    final claims = user is PyricUserPlatform ? user.customClaims : null;
    return AuthLens.asUser(
      uid: user.uid,
      tenant: user.tenantId ?? _tenantId,
      token: (claims != null && claims.isNotEmpty) ? claims : null,
    );
  }

  /// Switches active auth lens, or clears impersonation if null.
  void switchAuthLens(AuthLens? lens) {
    _impersonatedLens = lens;
    _lensController.add(currentAuthLens);
  }

  @override
  AuthLens get currentAuthLens {
    if (_impersonatedLens != null) return _impersonatedLens!;
    return _lensForUser(_currentUser);
  }

  @override
  Stream<AuthLens> get authLensChanges {
    return StreamGroup.merge([
      authStateChanges().map(_lensForUser),
      idTokenChanges().map(_lensForUser),
      _lensController.stream,
    ]).distinct();
  }

  @override
  Future<UserCredentialPlatform> signInWithEmailAndPassword(
    String email,
    String password,
  ) async {
    try {
      final res = await _bridgeClient.authSignInEmail(
        email,
        password,
        tenantId: _tenantId,
      );
      final userMap = Map<String, dynamic>.from(res['user'] as Map);
      if (_tenantId != null && userMap['tenantId'] == null) {
        userMap['tenantId'] = _tenantId;
      }
      if (res['claims'] != null && userMap['claims'] == null) {
        userMap['claims'] = res['claims'];
      }
      if (res['customClaims'] != null && userMap['customClaims'] == null) {
        userMap['customClaims'] = res['customClaims'];
      }
      final user = PyricUserPlatform.fromWire(
        auth: this,
        data: userMap,
        client: _bridgeClient,
      );
      _currentUser = user;
      _authStateController.add(user);
      _idTokenController.add(user);
      _userChangesController.add(user);
      final addInfo = res['additionalUserInfo'] as Map?;
      final isNewUser = addInfo != null ? (addInfo['isNewUser'] as bool? ?? false) : false;
      final providerId = addInfo != null ? addInfo['providerId'] as String? : res['providerId'] as String?;
      return PyricUserCredentialPlatform(
        auth: this,
        user: user,
        additionalUserInfo: AdditionalUserInfo(isNewUser: isNewUser, providerId: providerId),
      );
    } catch (e) {
      throw _mapAuthError(e);
    }
  }

  @override
  Future<UserCredentialPlatform> createUserWithEmailAndPassword(
    String email,
    String password,
  ) async {
    try {
      final res = await _bridgeClient.authCreateUser(
        email,
        password,
        tenantId: _tenantId,
      );
      final userMap = Map<String, dynamic>.from(res['user'] as Map);
      if (_tenantId != null && userMap['tenantId'] == null) {
        userMap['tenantId'] = _tenantId;
      }
      if (res['claims'] != null && userMap['claims'] == null) {
        userMap['claims'] = res['claims'];
      }
      if (res['customClaims'] != null && userMap['customClaims'] == null) {
        userMap['customClaims'] = res['customClaims'];
      }
      final user = PyricUserPlatform.fromWire(
        auth: this,
        data: userMap,
        client: _bridgeClient,
      );
      _currentUser = user;
      _authStateController.add(user);
      _idTokenController.add(user);
      _userChangesController.add(user);
      final addInfo = res['additionalUserInfo'] as Map?;
      final isNewUser = addInfo != null ? (addInfo['isNewUser'] as bool? ?? true) : true;
      final providerId = addInfo != null ? addInfo['providerId'] as String? : res['providerId'] as String?;
      return PyricUserCredentialPlatform(
        auth: this,
        user: user,
        additionalUserInfo: AdditionalUserInfo(isNewUser: isNewUser, providerId: providerId),
      );
    } catch (e) {
      throw _mapAuthError(e);
    }
  }

  @override
  Future<UserCredentialPlatform> signInAnonymously() async {
    try {
      final res = await _bridgeClient.authSignInAnonymously(tenantId: _tenantId);
      final userMap = Map<String, dynamic>.from(res['user'] as Map);
      if (_tenantId != null && userMap['tenantId'] == null) {
        userMap['tenantId'] = _tenantId;
      }
      if (res['claims'] != null && userMap['claims'] == null) {
        userMap['claims'] = res['claims'];
      }
      if (res['customClaims'] != null && userMap['customClaims'] == null) {
        userMap['customClaims'] = res['customClaims'];
      }
      final user = PyricUserPlatform.fromWire(
        auth: this,
        data: userMap,
        client: _bridgeClient,
      );
      _currentUser = user;
      _authStateController.add(user);
      _idTokenController.add(user);
      _userChangesController.add(user);
      final addInfo = res['additionalUserInfo'] as Map?;
      final isNewUser = addInfo != null ? (addInfo['isNewUser'] as bool? ?? true) : true;
      return PyricUserCredentialPlatform(
        auth: this,
        user: user,
        additionalUserInfo: AdditionalUserInfo(isNewUser: isNewUser),
      );
    } catch (e) {
      throw _mapAuthError(e);
    }
  }

  @override
  Future<UserCredentialPlatform> signInWithCredential(
    AuthCredential credential,
  ) async {
    try {
      final credMap = credential.asMap();
      final payload = <String, dynamic>{
        'providerId': credential.providerId,
        'signInMethod': credential.signInMethod,
        if (credMap['idToken'] != null) 'idToken': credMap['idToken'],
        if (credMap['accessToken'] != null)
          'accessToken': credMap['accessToken'],
        if (credMap['rawNonce'] != null) 'rawNonce': credMap['rawNonce'],
      };
      final res = await _bridgeClient.authSignInWithCredential(
        payload,
        tenantId: _tenantId,
      );
      final userMap = Map<String, dynamic>.from(res['user'] as Map);
      if (_tenantId != null && userMap['tenantId'] == null) {
        userMap['tenantId'] = _tenantId;
      }
      if (res['claims'] != null && userMap['claims'] == null) {
        userMap['claims'] = res['claims'];
      }
      if (res['customClaims'] != null && userMap['customClaims'] == null) {
        userMap['customClaims'] = res['customClaims'];
      }
      final user = PyricUserPlatform.fromWire(
        auth: this,
        data: userMap,
        client: _bridgeClient,
      );
      _currentUser = user;
      _authStateController.add(user);
      _idTokenController.add(user);
      _userChangesController.add(user);
      final isNewUser = (res['additionalUserInfo'] is Map)
          ? (res['additionalUserInfo']['isNewUser'] as bool? ?? false)
          : false;
      return PyricUserCredentialPlatform(
        auth: this,
        user: user,
        additionalUserInfo: AdditionalUserInfo(
          isNewUser: isNewUser,
          providerId: credential.providerId,
        ),
      );
    } catch (e) {
      throw _mapAuthError(e);
    }
  }

  @override
  Future<void> signOut() async {
    try {
      await _bridgeClient.authSignOut();
      _currentUser = null;
      _authStateController.add(null);
      _idTokenController.add(null);
      _userChangesController.add(null);
    } catch (e) {
      throw _mapAuthError(e);
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
    await _lensController.close();
    await _authStateController.close();
    await _idTokenController.close();
    await _userChangesController.close();
  }
}
