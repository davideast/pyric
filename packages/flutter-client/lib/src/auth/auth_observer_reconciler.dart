/// Coordinates local Auth op results against inbound `authState` / `idToken`
/// observer frames so neither a stale observer frame nor an out-of-order op
/// result (such as `reload()` completing after `signOut()`) can regress
/// `currentUser` or emit a stale user (ADR-0019 D9, F8).
class AuthObserverReconciler {
  int _nextMutationSeq = 0;
  int _appliedMutationSeq = 0;
  int _pendingLocalMutations = 0;

  final List<String?> _inFlightAuthStateUids = [];
  final List<String?> _inFlightIdTokenUids = [];
  final List<String?> _expectedAuthStateEchoes = [];
  final List<String?> _expectedIdTokenEchoes = [];

  int beginLocalMutation() {
    _pendingLocalMutations += 1;
    return ++_nextMutationSeq;
  }

  void endLocalMutation() {
    if (_pendingLocalMutations > 0) {
      _pendingLocalMutations -= 1;
    }
    if (_pendingLocalMutations == 0) {
      _inFlightAuthStateUids.clear();
      _inFlightIdTokenUids.clear();
    }
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
        inFlight: _inFlightAuthStateUids,
        expected: _expectedAuthStateEchoes,
        nextUid: nextUid,
      );
    }
    if (tokenChanged || nextUid != prevUid) {
      _recordExpectedEcho(
        inFlight: _inFlightIdTokenUids,
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

  bool shouldApplyAuthStateSnap(String? uid) {
    return _evaluateSnap(
      uid: uid,
      inFlight: _inFlightAuthStateUids,
      expected: _expectedAuthStateEchoes,
    );
  }

  bool shouldApplyIdTokenSnap(String? uid) {
    return _evaluateSnap(
      uid: uid,
      inFlight: _inFlightIdTokenUids,
      expected: _expectedIdTokenEchoes,
    );
  }

  void _recordExpectedEcho({
    required List<String?> inFlight,
    required List<String?> expected,
    required String? nextUid,
  }) {
    final idx = inFlight.indexOf(nextUid);
    if (idx >= 0) {
      inFlight.removeRange(0, idx + 1);
      expected.clear();
      return;
    }
    expected.add(nextUid);
  }

  bool _evaluateSnap({
    required String? uid,
    required List<String?> inFlight,
    required List<String?> expected,
  }) {
    if (_pendingLocalMutations > 0) {
      if (expected.isNotEmpty && expected.first == uid) {
        expected.removeAt(0);
      } else {
        inFlight.add(uid);
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
