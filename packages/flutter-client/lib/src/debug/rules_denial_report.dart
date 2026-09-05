import 'package:collection/collection.dart';
import '../transport/exceptions.dart';

String? _asString(dynamic v) => v == null ? null : (v is String ? v : v.toString());

int? _asInt(dynamic v) {
  if (v == null) return null;
  if (v is int) return v;
  if (v is num) return v.toInt();
  return int.tryParse(v.toString());
}

Map<String, dynamic>? _asStringMap(dynamic v) {
  if (v is! Map) return null;
  final result = <String, dynamic>{};
  for (final entry in v.entries) {
    if (entry.key != null) {
      result[entry.key.toString()] = entry.value;
    }
  }
  return result;
}

List<String> _asStringList(dynamic v) {
  if (v is! List) return [];
  final result = <String>[];
  for (final item in v) {
    if (item != null) {
      result.add(item.toString());
    }
  }
  return result;
}

/// Structured representation of a Security Rules evaluation failure (CEL rejection).
class RulesDenialReport {
  final String file;
  final int? line;
  final int? col;
  final String citation;
  final String? expression;
  final List<String> reasons;
  final String? authUid;
  final String? authTenant;
  final Map<String, dynamic>? authClaims;
  final String? requestMethod;
  final String? requestPath;
  final Map<String, dynamic>? proposedData;
  final Map<String, dynamic>? existingData;
  final List<String> failedFields;
  final Map<String, dynamic>? query;
  final String errorMessage;
  final DateTime timestamp;

  RulesDenialReport({
    this.file = 'firestore.rules',
    this.line,
    this.col,
    String? citation,
    this.expression,
    this.reasons = const [],
    this.authUid,
    this.authTenant,
    this.authClaims,
    this.requestMethod,
    this.requestPath,
    this.proposedData,
    this.existingData,
    this.failedFields = const [],
    this.query,
    this.errorMessage = 'Missing or insufficient permissions.',
    DateTime? timestamp,
  })  : citation = citation != null && citation.isNotEmpty
            ? citation
            : line != null
                ? col != null
                    ? '$file:$line:$col'
                    : '$file:$line'
                : file,
        timestamp = timestamp ?? DateTime.now();

  /// Constructs a `RulesDenialReport` from a `denialContext` map and error message.
  factory RulesDenialReport.fromMap(
    Map<dynamic, dynamic> map, {
    String errorMessage = 'Missing or insufficient permissions.',
  }) {
    final ruleObj = _asStringMap(map['rule']);
    final file = _asString(ruleObj?['file']) ?? 'firestore.rules';
    final line = _asInt(ruleObj?['line']);
    final col = _asInt(ruleObj?['col']) ?? _asInt(ruleObj?['column']);
    final citation = _asString(ruleObj?['citation']);
    final expression = _asString(ruleObj?['expression']);

    final reasons = _asStringList(map['reasons']);
    if (reasons.isEmpty) {
      reasons.add(errorMessage);
    }

    final authObj = _asStringMap(map['auth']);
    final authUid = _asString(authObj?['uid']);
    final authClaims = _asStringMap(authObj?['token']);
    final firebaseMap = _asStringMap(authClaims?['firebase']);
    final authTenant = _asString(firebaseMap?['tenant']) ?? _asString(authObj?['tenant']);

    final reqObj = _asStringMap(map['request']);
    final requestMethod = _asString(reqObj?['method']);
    final requestPath = _asString(reqObj?['path']);
    final proposedData = _asStringMap(reqObj?['resourceData']);

    final resObj = _asStringMap(map['resource']);
    final existingData = _asStringMap(resObj?['data']);

    final failedFields = _asStringList(map['failedFields']);

    final query = _asStringMap(map['query']);

    return RulesDenialReport(
      file: file,
      line: line,
      col: col,
      citation: citation,
      expression: expression,
      reasons: reasons,
      authUid: authUid,
      authTenant: authTenant,
      authClaims: authClaims,
      requestMethod: requestMethod,
      requestPath: requestPath,
      proposedData: proposedData,
      existingData: existingData,
      failedFields: failedFields,
      query: query,
      errorMessage: errorMessage,
    );
  }

  /// Extracts a `RulesDenialReport` from a `PyricBridgeException` if it contains `denialContext`.
  static RulesDenialReport? fromBridgeException(PyricBridgeException ex) {
    if (ex.denialContext is! Map) return null;
    return RulesDenialReport.fromMap(
      ex.denialContext as Map,
      errorMessage: ex.message,
    );
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is RulesDenialReport &&
        other.citation == citation &&
        other.expression == expression &&
        other.authUid == authUid &&
        const ListEquality().equals(other.reasons, reasons);
  }

  @override
  int get hashCode => Object.hash(
        citation,
        expression,
        authUid,
        const ListEquality().hash(reasons),
      );
}
