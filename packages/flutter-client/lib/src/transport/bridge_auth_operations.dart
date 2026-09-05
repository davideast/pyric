import 'bridge_client.dart';

/// Extension methods adding Auth-specific RPC conveniences to [PyricBridgeClient].
extension PyricBridgeAuthOps on PyricBridgeClient {
  /// Signs in a user with email and password.
  Future<dynamic> authSignInEmail(String email, String password) {
    return op('auth.signInEmail', {'email': email, 'password': password});
  }

  /// Creates a new user with email and password.
  Future<dynamic> authCreateUser(String email, String password) {
    return op('auth.createUser', {'email': email, 'password': password});
  }

  /// Signs in anonymously.
  Future<dynamic> authSignInAnonymously() {
    return op('auth.signInAnonymously', {});
  }

  /// Signs out the current user session.
  Future<dynamic> authSignOut() {
    return op('auth.signOut', {});
  }

  /// Fetches the ID token for the current user.
  Future<String?> authGetIdToken({bool forceRefresh = false}) async {
    final res = await op('auth.getIdToken', {'forceRefresh': forceRefresh});
    return res as String?;
  }

  /// Fetches structured ID token results with claims and timestamps.
  Future<Map<String, dynamic>> authGetIdTokenResult({
    bool forceRefresh = false,
  }) async {
    final res = await op(
      'auth.getIdTokenResult',
      {'forceRefresh': forceRefresh},
    );
    return Map<String, dynamic>.from(res as Map);
  }

  /// Fetches the current user profile from the worker.
  Future<dynamic> authGetCurrentUser() {
    return op('auth.getCurrentUser', {});
  }

  /// Updates displayName and/or photoURL on the user profile.
  Future<dynamic> authUpdateProfile({String? displayName, String? photoURL}) {
    return op('auth.updateProfile', {
      if (displayName != null) 'displayName': displayName,
      if (photoURL != null) 'photoURL': photoURL,
    });
  }

  /// Restores a previously persisted port session by UID.
  Future<dynamic> authRestorePortSession(String uid) {
    return op('auth.restorePortSession', {'uid': uid});
  }

  /// Sets session persistence mode (e.g. 'LOCAL', 'SESSION', 'NONE').
  Future<void> authSetPersistence(String mode) async {
    await op('auth.setPersistence', {'mode': mode});
  }

  /// Lists all sandbox users via the auth.listUsers RPC.
  Future<List<Map<String, dynamic>>> authListUsers() async {
    final res = await op('auth.listUsers', {});
    if (res is List) {
      return res.map((item) => Map<String, dynamic>.from(item as Map)).toList();
    }
    return [];
  }
}
