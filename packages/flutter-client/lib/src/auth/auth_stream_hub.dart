import 'dart:async';

import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';

import 'auth_lens.dart';

/// Owns the synchronous broadcast controllers for `authStateChanges`,
/// `idTokenChanges`, `userChanges`, and `authLensChanges`.
///
/// Forwarding synchronously guarantees:
/// - D8: Auth observer events have the same single async bridge hop as
///   Firestore and RTDB listeners.
/// - D6 (F3-F5): Bridge shutdown closes every stream synchronously inside
///   `disconnect()` with zero uncaught errors on `authLensChanges`.
/// - D9 (F6): `authLensChanges` replays `currentAuthLens` (respecting active
///   impersonation) once on listen and emits deduplicated transitions only.
class AuthStreamHub {
  final UserPlatform? Function() readCurrentUser;
  final AuthLens Function() readCurrentLens;

  String? _lastAuthStateUid;
  AuthLens _lastEmittedLens = AuthLens.anon;

  final StreamController<UserPlatform?> _authStateController =
      StreamController<UserPlatform?>.broadcast(sync: true);
  final StreamController<UserPlatform?> _idTokenController =
      StreamController<UserPlatform?>.broadcast(sync: true);
  final StreamController<UserPlatform?> _userChangesController =
      StreamController<UserPlatform?>.broadcast(sync: true);
  final StreamController<AuthLens> _lensController =
      StreamController<AuthLens>.broadcast(sync: true);

  AuthStreamHub({
    required this.readCurrentUser,
    required this.readCurrentLens,
  });

  String? get lastAuthStateUid => _lastAuthStateUid;

  void seedInitial({required String? uid, required AuthLens lens}) {
    _lastAuthStateUid = uid;
    _lastEmittedLens = lens;
  }

  void setLastAuthStateUid(String? uid) {
    _lastAuthStateUid = uid;
  }

  void emitAuthStateIfChanged(UserPlatform? user) {
    final nextUid = user?.uid;
    if (nextUid != _lastAuthStateUid) {
      _lastAuthStateUid = nextUid;
      if (!_authStateController.isClosed) {
        _authStateController.add(user);
      }
    }
  }

  void emitAuthStateForced(UserPlatform? user) {
    _lastAuthStateUid = user?.uid;
    if (!_authStateController.isClosed) {
      _authStateController.add(user);
    }
  }

  void emitIdToken(UserPlatform? user) {
    if (!_idTokenController.isClosed) {
      _idTokenController.add(user);
    }
  }

  void emitUserChanges(UserPlatform? user) {
    if (!_userChangesController.isClosed) {
      _userChangesController.add(user);
    }
  }

  void emitLensIfChanged() {
    final next = readCurrentLens();
    if (next == _lastEmittedLens) return;
    _lastEmittedLens = next;
    if (!_lensController.isClosed) {
      _lensController.add(next);
    }
  }

  void addAuthStateError(Object err) {
    if (!_authStateController.isClosed) {
      _authStateController.addError(err);
    }
  }

  void addIdTokenError(Object err) {
    if (!_idTokenController.isClosed) {
      _idTokenController.addError(err);
    }
  }

  void closeAuthState() {
    if (!_authStateController.isClosed) {
      _authStateController.close();
    }
  }

  void closeIdToken() {
    if (!_idTokenController.isClosed) {
      _idTokenController.close();
    }
  }

  void closeAllSync() {
    closeAuthState();
    closeIdToken();
    if (!_userChangesController.isClosed) _userChangesController.close();
    if (!_lensController.isClosed) _lensController.close();
  }

  Future<void> dispose() async {
    if (!_lensController.isClosed) await _lensController.close();
    if (!_authStateController.isClosed) await _authStateController.close();
    if (!_idTokenController.isClosed) await _idTokenController.close();
    if (!_userChangesController.isClosed) await _userChangesController.close();
  }

  Stream<UserPlatform?> authStateChanges() =>
      _replayingUserStream(_authStateController);

  Stream<UserPlatform?> idTokenChanges() =>
      _replayingUserStream(_idTokenController);

  Stream<UserPlatform?> userChanges() =>
      _replayingUserStream(_userChangesController);

  Stream<AuthLens> get authLensChanges {
    return Stream<AuthLens>.multi((controller) {
      if (_lensController.isClosed) {
        controller.close();
        return;
      }
      var hasDelivered = false;
      AuthLens? lastDelivered;

      void deliverSync(AuthLens next) {
        if (controller.isClosed) return;
        if (hasDelivered && next == lastDelivered) return;
        hasDelivered = true;
        lastDelivered = next;
        controller.addSync(next);
      }

      final sub = _lensController.stream.listen(
        deliverSync,
        onError: (Object _, StackTrace __) {},
        onDone: () {
          if (!controller.isClosed) controller.closeSync();
        },
      );
      controller.onCancel = () {
        unawaited(sub.cancel());
      };
      scheduleMicrotask(() {
        if (controller.isClosed || _lensController.isClosed || hasDelivered) {
          return;
        }
        deliverSync(readCurrentLens());
      });
    }, isBroadcast: true);
  }

  Stream<UserPlatform?> _replayingUserStream(
    StreamController<UserPlatform?> source,
  ) {
    return Stream<UserPlatform?>.multi((controller) {
      if (source.isClosed) {
        controller.close();
        return;
      }
      var hasDelivered = false;
      final sub = source.stream.listen(
        (user) {
          hasDelivered = true;
          if (!controller.isClosed) controller.addSync(user);
        },
        onError: (Object err, StackTrace st) {
          if (!controller.isClosed) controller.addErrorSync(err, st);
        },
        onDone: () {
          if (!controller.isClosed) controller.closeSync();
        },
      );
      controller.onCancel = () {
        unawaited(sub.cancel());
      };
      scheduleMicrotask(() {
        if (controller.isClosed || source.isClosed || hasDelivered) return;
        hasDelivered = true;
        controller.addSync(readCurrentUser());
      });
    }, isBroadcast: true);
  }
}
