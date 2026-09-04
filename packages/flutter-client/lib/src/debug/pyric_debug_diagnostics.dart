import 'dart:async';

import '../transport/bridge_client.dart';
import 'rules_denial_report.dart';

/// Central diagnostics hub that receives and broadcasts Security Rules denial events.
class PyricDebugDiagnostics {
  static final PyricDebugDiagnostics instance = PyricDebugDiagnostics._();

  final StreamController<RulesDenialReport> _denialsController =
      StreamController<RulesDenialReport>.broadcast();
  final List<RulesDenialReport> _history = [];
  final int maxHistoryCount = 20;

  PyricDebugDiagnostics._() {
    // Intercept bridge client denial events
    PyricBridgeClient.onDenial = (ex) {
      recordException(ex);
    };
  }

  /// Exposes the denial event stream.
  Stream<RulesDenialReport> get denials => _denialsController.stream;

  /// Returns recent denial history (capped at 20).
  List<RulesDenialReport> get history => List.unmodifiable(_history);

  /// Records a new `RulesDenialReport` and notifies all listeners.
  void recordDenial(RulesDenialReport report) {
    _history.insert(0, report);
    if (_history.length > maxHistoryCount) {
      _history.removeLast();
    }
    _denialsController.add(report);
  }

  /// Extracts and records a denial from a `PyricBridgeException` if available.
  void recordException(PyricBridgeException ex) {
    final report = RulesDenialReport.fromBridgeException(ex);
    if (report != null) {
      recordDenial(report);
    }
  }

  /// Clears the denial history.
  void clear() {
    _history.clear();
  }
}
