/// Normalized observer frame buffered while a local Auth mutation is in flight.
class BufferedAuthSnap {
  final int order;
  final bool isAuthState;
  final String? uid;
  final Map<String, dynamic>? normalized;

  const BufferedAuthSnap({
    required this.order,
    required this.isAuthState,
    required this.uid,
    required this.normalized,
  });
}

/// Coordinates local Auth op results against inbound `authState` / `idToken`
/// observer frames so neither a stale observer frame nor an out-of-order op
/// result (such as `reload()` completing after `signOut()`) can regress
/// `currentUser` or emit a stale user (ADR-0019 D9, F8).
class AuthObserverReconciler {
  int _nextMutationSeq = 0;
  int _appliedMutationSeq = 0;
  int _pendingLocalMutations = 0;
  int _nextSnapOrder = 0;

  final List<BufferedAuthSnap> _inFlightAuthState = [];
  final List<BufferedAuthSnap> _inFlightIdToken = [];
  final List<String?> _expectedAuthStateEchoes = [];
  final List<String?> _expectedIdTokenEchoes = [];

  /// Allocates a monotonic sequence number without deferring inbound observer
  /// frames (used by read-only operations such as `getIdToken(false)`).
  int allocateMutationSeq() => ++_nextMutationSeq;

  int beginLocalMutation() {
    _pendingLocalMutations += 1;
    return ++_nextMutationSeq;
  }

  /// Ends one in-flight mutating Auth operation. When the last in-flight
  /// mutation finishes, returns any buffered observer snapshots not consumed
  /// by `recordLocalTransition` in arrival order so external changes arriving
  /// during failed mutations are never dropped.
  List<BufferedAuthSnap> endLocalMutation() {
    if (_pendingLocalMutations > 0) {
      _pendingLocalMutations -= 1;
    }
    if (_pendingLocalMutations > 0) {
      return const [];
    }
    if (_inFlightAuthState.isEmpty && _inFlightIdToken.isEmpty) {
      return const [];
    }
    final remaining = <BufferedAuthSnap>[
      ..._inFlightAuthState,
      ..._inFlightIdToken,
    ]..sort((a, b) => a.order.compareTo(b.order));
    _inFlightAuthState.clear();
    _inFlightIdToken.clear();
    return remaining;
  }

  /// Claims ordering for [seq]. Returns `false` if a newer local mutation has
  /// already applied, so stale op results do not overwrite `currentUser`.
  bool tryClaimMutation(int seq) {
    if (seq < _appliedMutationSeq) return false;
    _appliedMutationSeq = seq;
    return true;
  }

  /// Records a locally applied auth transition so stale observer frames for
  /// superseded UIDs are suppressed until the observer catches up.
  void recordLocalTransition({
    required String? prevUid,
    required String? nextUid,
    required bool authStateChanged,
    required bool tokenChanged,
  }) {
    if (authStateChanged || nextUid != prevUid) {
      _recordExpectedEcho(
        inFlight: _inFlightAuthState,
        expected: _expectedAuthStateEchoes,
        nextUid: nextUid,
      );
    }
    if (tokenChanged || nextUid != prevUid) {
      _recordExpectedEcho(
        inFlight: _inFlightIdToken,
        expected: _expectedIdTokenEchoes,
        nextUid: nextUid,
      );
    }
  }

  /// Clears pending echo expectations (on socket drop or manual test override).
  void resetEchoes() {
    _expectedAuthStateEchoes.clear();
    _expectedIdTokenEchoes.clear();
  }

  bool shouldApplyAuthStateSnap(Map<String, dynamic>? normalized) {
    return _evaluateSnap(
      isAuthState: true,
      normalized: normalized,
      inFlight: _inFlightAuthState,
      expected: _expectedAuthStateEchoes,
    );
  }

  bool shouldApplyIdTokenSnap(Map<String, dynamic>? normalized) {
    return _evaluateSnap(
      isAuthState: false,
      normalized: normalized,
      inFlight: _inFlightIdToken,
      expected: _expectedIdTokenEchoes,
    );
  }

  void _recordExpectedEcho({
    required List<BufferedAuthSnap> inFlight,
    required List<String?> expected,
    required String? nextUid,
  }) {
    final idx = inFlight.indexWhere((entry) => entry.uid == nextUid);
    if (idx >= 0) {
      inFlight.removeRange(0, idx + 1);
      expected.clear();
      return;
    }
    expected.add(nextUid);
  }

  bool _evaluateSnap({
    required bool isAuthState,
    required Map<String, dynamic>? normalized,
    required List<BufferedAuthSnap> inFlight,
    required List<String?> expected,
  }) {
    final uid = normalized?['uid'] as String?;
    if (_pendingLocalMutations > 0) {
      if (expected.isNotEmpty && expected.first == uid) {
        expected.removeAt(0);
      } else {
        inFlight.add(
          BufferedAuthSnap(
            order: ++_nextSnapOrder,
            isAuthState: isAuthState,
            uid: uid,
            normalized: normalized,
          ),
        );
      }
      return false;
    }
    if (expected.isEmpty) return true;
    final idx = expected.indexOf(uid);
    if (idx < 0) {
      // Unrelated external state change from another client or test fixture.
      expected.clear();
      return true;
    }
    final isSuperseded = idx < expected.length - 1;
    expected.removeRange(0, idx + 1);
    return !isSuperseded;
  }
}
