import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';

import '../auth/auth_lens.dart';
import '../auth/pyric_firebase_auth_platform.dart';
import '../transport/bridge_client.dart';
import 'pyric_debug_diagnostics.dart';
import 'rules_denial_report.dart';
import 'sandbox_user_record.dart';

/// State controller for mobile identity switching and CEL denial diagnostics.
class PyricDebugController extends ChangeNotifier {
  final PyricFirebaseAuthPlatform _authPlatform;
  final PyricBridgeClient _bridgeClient;
  final PyricDebugDiagnostics _diagnostics;

  List<SandboxUserRecord> _users = [];
  bool _isLoadingUsers = false;
  bool _disposed = false;
  Future<void>? _refreshInFlight;
  String? _lastSessionUid;
  AuthLens _currentLens = AuthLens.anon;
  final List<RulesDenialReport> _denials = [];

  StreamSubscription<AuthLens>? _lensSub;
  StreamSubscription<AuthLens>? _remoteLensSub;
  StreamSubscription<RulesDenialReport>? _denialSub;
  StreamSubscription<UserPlatform?>? _authStateSub;

  PyricDebugController({
    PyricFirebaseAuthPlatform? authPlatform,
    PyricBridgeClient? bridgeClient,
    PyricDebugDiagnostics? diagnostics,
  })  : _authPlatform = authPlatform ?? (FirebaseAuthPlatform.instance is PyricFirebaseAuthPlatform
            ? FirebaseAuthPlatform.instance as PyricFirebaseAuthPlatform
            : PyricFirebaseAuthPlatform()),
        _bridgeClient = bridgeClient ??
            (authPlatform?.bridgeClient ?? PyricBridgeClient()),
        _diagnostics = diagnostics ?? PyricDebugDiagnostics.instance {
    _currentLens = _authPlatform.currentAuthLens;
    _lastSessionUid = _authPlatform.currentUser?.uid;
    _denials.addAll(_diagnostics.history);

    _initSubscriptions();
    unawaited(refreshUsers(silent: true));
  }

  void _initSubscriptions() {
    _lensSub = _authPlatform.authLensChanges.listen(
      (lens) {
        _currentLens = lens;
        if (lens.mode == 'as' && _users.isEmpty) {
          unawaited(refreshUsers(silent: true));
        }
        _notifyIfAlive();
      },
      onError: (Object _, StackTrace __) {},
    );

    _authStateSub = _authPlatform.authStateChanges().listen(
      (user) {
        final nextUid = user?.uid;
        if (_lastSessionUid != null && nextUid != _lastSessionUid) {
          clearDenials();
        }
        _lastSessionUid = nextUid;
        if (nextUid != null && _users.isEmpty) {
          unawaited(refreshUsers(silent: true));
        }
      },
      onError: (Object _, StackTrace __) {},
    );

    _remoteLensSub = _bridgeClient.remoteLensStream.listen(
      (lens) {
        _authPlatform.switchAuthLens(lens);
      },
      onError: (Object _, StackTrace __) {},
    );

    _denialSub = _diagnostics.denials.listen((report) {
      _denials.insert(0, report);
      if (_denials.length > 20) {
        _denials.removeLast();
      }
      _notifyIfAlive();
    });
  }

  void _notifyIfAlive() {
    if (!_disposed) {
      notifyListeners();
    }
  }

  /// Available sandbox users discovered via bridge `auth.listUsers`.
  List<SandboxUserRecord> get users => List.unmodifiable(_users);

  /// Whether user loading is currently active.
  bool get isLoadingUsers => _isLoadingUsers;

  /// Active authentication lens.
  AuthLens get currentLens => _currentLens;

  /// Whether Admin Bypass mode is currently enabled.
  bool get isAdminBypass => _currentLens == AuthLens.admin;

  /// Recorded Security Rules evaluation rejections.
  List<RulesDenialReport> get denials => List.unmodifiable(_denials);

  /// Most recent rejection report.
  RulesDenialReport? get latestDenial =>
      _denials.isNotEmpty ? _denials.first : null;

  /// Short display title for the currently active identity.
  String get activeIdentityTitle {
    switch (_currentLens.mode) {
      case 'admin':
        return 'ADMIN';
      case 'anon':
        return 'ANONYMOUS';
      case 'app-session':
        return 'APP SESSION';
      case 'as':
        final uid = _currentLens.uid ?? '';
        final user = _users.firstWhere(
          (u) => u.uid == uid,
          orElse: () => SandboxUserRecord(uid: uid),
        );
        if (user.email != null && user.email!.isNotEmpty) {
          return user.email!;
        }
        if (user.displayName != null && user.displayName!.isNotEmpty) {
          return user.displayName!;
        }
        final tokenEmail = _currentLens.token?['email'];
        if (tokenEmail is String && tokenEmail.isNotEmpty) {
          return tokenEmail;
        }
        final tokenName = _currentLens.token?['name'];
        if (tokenName is String && tokenName.isNotEmpty) {
          return tokenName;
        }
        final tenant = _currentLens.tenant;
        if (tenant != null && tenant.isNotEmpty) {
          return '$uid ($tenant)';
        }
        return uid;
      default:
        return 'CUSTOM';
    }
  }

  /// Refreshes sandbox users from the bridge server.
  ///
  /// When [silent] is `true`, the request executes in the background without
  /// toggling [isLoadingUsers].
  Future<void> refreshUsers({bool silent = false}) {
    if (_disposed) return Future<void>.value();
    final existing = _refreshInFlight;
    if (existing != null) return existing;
    final future = _doRefreshUsers(silent: silent);
    _refreshInFlight = future;
    future.whenComplete(() {
      if (identical(_refreshInFlight, future)) {
        _refreshInFlight = null;
      }
    });
    return future;
  }

  Future<void> _doRefreshUsers({required bool silent}) async {
    if (!silent) {
      _isLoadingUsers = true;
      _notifyIfAlive();
    }

    try {
      final rawList = await _bridgeClient.authListUsers();
      if (_disposed) return;
      _users = rawList.map((m) => SandboxUserRecord.fromMap(m)).toList();
    } catch (_) {
      // Keep existing users on failure
    } finally {
      if (!silent) {
        _isLoadingUsers = false;
      }
      _notifyIfAlive();
    }
  }

  /// Switches active impersonation identity to the given sandbox user.
  void selectUser(SandboxUserRecord user) {
    final hydrated = <String, dynamic>{...user.customClaims};
    if (user.email != null && user.email!.isNotEmpty) {
      hydrated.putIfAbsent('email', () => user.email);
    }
    if (user.displayName != null && user.displayName!.isNotEmpty) {
      hydrated.putIfAbsent('name', () => user.displayName);
    }
    _authPlatform.switchAuthLens(
      AuthLens.asUser(
        uid: user.uid,
        tenant: user.tenantId,
        token: hydrated.isNotEmpty ? hydrated : null,
      ),
    );
  }

  /// Toggles Admin Bypass mode.
  void toggleAdminBypass(bool enabled) {
    if (enabled) {
      _authPlatform.switchAuthLens(AuthLens.admin);
    } else {
      _authPlatform.switchAuthLens(null);
    }
  }

  /// Switches to unauthenticated anonymous identity.
  void selectAnon() {
    _authPlatform.switchAuthLens(AuthLens.anon);
  }

  /// Switches to App Session mirroring the browser tab.
  void selectAppSession() {
    _authPlatform.switchAuthLens(AuthLens.appSession);
  }

  /// Clears recorded rule denials.
  void clearDenials() {
    _denials.clear();
    _diagnostics.clear();
    _notifyIfAlive();
  }

  /// Manually records a denial report.
  void addDenial(RulesDenialReport report) {
    _diagnostics.recordDenial(report);
  }

  @override
  void dispose() {
    _disposed = true;
    _lensSub?.cancel();
    _authStateSub?.cancel();
    _remoteLensSub?.cancel();
    _denialSub?.cancel();
    super.dispose();
  }
}
