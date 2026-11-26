import 'dart:async';

import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';

import 'auth_lens.dart';

class _ChannelListener<T> {
  final void Function(T) onData;
  final void Function(Object, StackTrace)? onError;
  final void Function() onDone;

  _ChannelListener({
    required this.onData,
    required this.onDone,
    this.onError,
  });
}

/// Synchronous broadcast channel with FIFO re-entrancy draining so callbacks
/// that trigger nested `switchAuthLens`, `tenantId =`, or auth change events
/// never throw `StateError: Controller is already firing an event`.
class _SyncBroadcastChannel<T> {
  final List<_ChannelListener<T>> _listeners = [];
  final List<void Function()> _queue = [];
  bool _draining = false;
  bool _closed = false;

  bool get isClosed => _closed;

  void Function() addListener(_ChannelListener<T> listener) {
    if (_closed) {
      listener.onDone();
      return () {};
    }
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }

  void add(T value) {
    if (_closed) return;
    _enqueue(() {
      if (_closed) return;
      final snapshot = List<_ChannelListener<T>>.of(_listeners);
      for (final listener in snapshot) {
        if (_listeners.contains(listener)) {
          listener.onData(value);
        }
      }
    });
  }

  void addError(Object error, [StackTrace? stackTrace]) {
    if (_closed) return;
    final trace = stackTrace ?? StackTrace.current;
    _enqueue(() {
      if (_closed) return;
      final snapshot = List<_ChannelListener<T>>.of(_listeners);
      for (final listener in snapshot) {
        if (_listeners.contains(listener)) {
          listener.onError?.call(error, trace);
        }
      }
    });
  }

  void close() {
    if (_closed) return;
    _closed = true;
    _enqueue(() {
      final snapshot = List<_ChannelListener<T>>.of(_listeners);
      _listeners.clear();
      for (final listener in snapshot) {
        listener.onDone();
      }
    });
  }

  void _enqueue(void Function() action) {
    _queue.add(action);
    if (_draining) return;
    _draining = true;
    try {
      while (_queue.isNotEmpty) {
        final next = _queue.removeAt(0);
        next();
      }
    } finally {
      _draining = false;
    }
  }
}

/// Owns the synchronous broadcast channels for `authStateChanges`,
/// `idTokenChanges`, `userChanges`, and `authLensChanges`.
///
/// Forwarding synchronously with FIFO re-entrancy draining guarantees:
/// - D8: Auth observer events have the same single async bridge hop as
///   Firestore and RTDB listeners, without throwing on re-entrant emissions.
/// - D6 (F3-F5): Bridge shutdown closes every stream synchronously inside
///   `disconnect()` with zero uncaught errors on `authLensChanges`.
/// - D9 (F6): `authLensChanges` replays `currentAuthLens` (respecting active
///   impersonation) once on listen and emits deduplicated transitions only.
class AuthStreamHub {
  final UserPlatform? Function() readCurrentUser;
  final AuthLens Function() readCurrentLens;

  String? _lastAuthStateUid;
  AuthLens _lastEmittedLens = AuthLens.anon;

  final _SyncBroadcastChannel<UserPlatform?> _authStateChannel =
      _SyncBroadcastChannel<UserPlatform?>();
  final _SyncBroadcastChannel<UserPlatform?> _idTokenChannel =
      _SyncBroadcastChannel<UserPlatform?>();
  final _SyncBroadcastChannel<UserPlatform?> _userChangesChannel =
      _SyncBroadcastChannel<UserPlatform?>();
  final _SyncBroadcastChannel<AuthLens> _lensChannel =
      _SyncBroadcastChannel<AuthLens>();

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
      _authStateChannel.add(user);
    }
  }

  void emitAuthStateForced(UserPlatform? user) {
    _lastAuthStateUid = user?.uid;
    _authStateChannel.add(user);
  }

  void emitIdToken(UserPlatform? user) => _idTokenChannel.add(user);

  void emitUserChanges(UserPlatform? user) => _userChangesChannel.add(user);

  void emitLensIfChanged() {
    final next = readCurrentLens();
    if (next == _lastEmittedLens) return;
    _lastEmittedLens = next;
    _lensChannel.add(next);
  }

  void addAuthStateError(Object err) => _authStateChannel.addError(err);

  void addIdTokenError(Object err) => _idTokenChannel.addError(err);

  void closeAuthState() => _authStateChannel.close();

  void closeIdToken() => _idTokenChannel.close();

  void closeAllSync() {
    _authStateChannel.close();
    _idTokenChannel.close();
    _userChangesChannel.close();
    _lensChannel.close();
  }

  Future<void> dispose() async {
    closeAllSync();
  }

  Stream<UserPlatform?> authStateChanges() =>
      _replayingUserStream(_authStateChannel);

  Stream<UserPlatform?> idTokenChanges() =>
      _replayingUserStream(_idTokenChannel);

  Stream<UserPlatform?> userChanges() =>
      _replayingUserStream(_userChangesChannel);

  Stream<AuthLens> get authLensChanges {
    return Stream<AuthLens>.multi((controller) {
      if (_lensChannel.isClosed) {
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

      final detach = _lensChannel.addListener(
        _ChannelListener<AuthLens>(
          onData: deliverSync,
          onDone: () {
            if (!controller.isClosed) controller.closeSync();
          },
        ),
      );
      controller.onCancel = detach;
      scheduleMicrotask(() {
        if (controller.isClosed || _lensChannel.isClosed || hasDelivered) {
          return;
        }
        deliverSync(readCurrentLens());
      });
    }, isBroadcast: true);
  }

  Stream<UserPlatform?> _replayingUserStream(
    _SyncBroadcastChannel<UserPlatform?> source,
  ) {
    return Stream<UserPlatform?>.multi((controller) {
      if (source.isClosed) {
        controller.close();
        return;
      }
      var hasDelivered = false;
      final detach = source.addListener(
        _ChannelListener<UserPlatform?>(
          onData: (user) {
            hasDelivered = true;
            if (!controller.isClosed) controller.addSync(user);
          },
          onError: (Object err, StackTrace st) {
            if (!controller.isClosed) controller.addErrorSync(err, st);
          },
          onDone: () {
            if (!controller.isClosed) controller.closeSync();
          },
        ),
      );
      controller.onCancel = detach;
      scheduleMicrotask(() {
        if (controller.isClosed || source.isClosed || hasDelivered) return;
        hasDelivered = true;
        controller.addSync(readCurrentUser());
      });
    }, isBroadcast: true);
  }
}
