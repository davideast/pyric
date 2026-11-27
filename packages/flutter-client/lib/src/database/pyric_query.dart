import 'dart:async';

import 'connection_info.dart';
import 'pyric_data_snapshot.dart';
import 'pyric_database.dart';
import 'pyric_database_reference.dart';

/// Represents a query over a Realtime Database location with optional ordering, filtering, and limits.
class PyricQuery {
  final PyricDatabase database;
  final String path;
  final Map<String, dynamic>? _orderBy;
  final List<Map<String, dynamic>> _bounds;
  final Map<String, dynamic>? _limit;

  const PyricQuery(
    this.database,
    this.path, {
    Map<String, dynamic>? orderBy,
    List<Map<String, dynamic>> bounds = const [],
    Map<String, dynamic>? limit,
  })  : _orderBy = orderBy,
        _bounds = bounds,
        _limit = limit;

  /// Returns the [PyricDatabaseReference] for this query's location.
  PyricDatabaseReference get ref => database.ref(path);

  /// Serializes the query constraints into the Pyric worker `RtdbQuerySpec` format.
  Map<String, dynamic>? toQuerySpec() {
    if (_orderBy == null && _bounds.isEmpty && _limit == null) {
      return null;
    }
    return {
      'orderBy': _orderBy,
      'bounds': List<Map<String, dynamic>>.unmodifiable(_bounds),
      'limit': _limit,
    };
  }

  static bool _containsInvalidKeyChars(String segment) {
    for (final rune in segment.runes) {
      if (rune <= 0x1F || rune == 0x7F) return true;
      // '.', '#', '$', '[', ']'
      if (rune == 0x2E ||
          rune == 0x23 ||
          rune == 0x24 ||
          rune == 0x5B ||
          rune == 0x5D) {
        return true;
      }
    }
    return false;
  }

  static String _trimSlashes(String raw) {
    var start = 0;
    var end = raw.length;
    while (start < end && raw.codeUnitAt(start) == 0x2F) {
      start++;
    }
    while (end > start && raw.codeUnitAt(end - 1) == 0x2F) {
      end--;
    }
    return raw.substring(start, end);
  }

  bool _hasStartBound() => _bounds.any((b) {
        final kind = b['kind'];
        return kind == 'startAt' || kind == 'startAfter' || kind == 'equalTo';
      });

  bool _hasEndBound() => _bounds.any((b) {
        final kind = b['kind'];
        return kind == 'endAt' || kind == 'endBefore' || kind == 'equalTo';
      });

  void _requireNoOrderBy() {
    if (_orderBy != null) {
      throw ArgumentError("You can't combine multiple orderBy calls!");
    }
  }

  static void _validateBoundValue(Object? value) {
    if (value == null || value is bool || value is String || value is int) {
      return;
    }
    if (value is double) {
      if (!value.isFinite) {
        throw ArgumentError('Query bound value must be a finite number.');
      }
      return;
    }
    throw ArgumentError(
      'Query bound value must be null, bool, String, or a finite number.',
    );
  }

  static void _validateKeyCursor(String? key) {
    if (key == null) return;
    if (key.isEmpty || key.contains('/') || _containsInvalidKeyChars(key)) {
      throw ArgumentError('Invalid child key ($key) passed to query cursor.');
    }
  }

  Map<String, dynamic> _buildValidatedBound(
    String kind,
    Object? value, {
    String? key,
  }) {
    final isStart =
        kind == 'startAt' || kind == 'startAfter' || kind == 'equalTo';
    final isEnd = kind == 'endAt' || kind == 'endBefore' || kind == 'equalTo';
    if (isStart && _hasStartBound()) {
      throw ArgumentError(
        "Can't call $kind() after startAt(), startAfter(), or equalTo()!",
      );
    }
    if (isEnd && _hasEndBound()) {
      throw ArgumentError(
        "Can't call $kind() after endAt(), endBefore(), or equalTo()!",
      );
    }
    _validateKeyCursor(key);
    _validateBoundValue(value);
    if (_orderBy?['kind'] == 'key') {
      if (key != null) {
        throw ArgumentError(
          "Can't pass a key cursor to $kind() on an orderByKey() query!",
        );
      }
      if (value is! String) {
        throw ArgumentError(
          'Query cursor value on an orderByKey() query must be a String.',
        );
      }
    }
    return <String, dynamic>{
      'kind': kind,
      'value': value,
      if (key != null) 'key': key,
    };
  }

  /// Orders results by the value of the specified nested child [childPath].
  PyricQuery orderByChild(String childPath) {
    _requireNoOrderBy();
    final trimmed = _trimSlashes(childPath);
    if (trimmed.isEmpty) {
      throw ArgumentError('orderByChild path cannot be empty!');
    }
    final segments = trimmed.split('/');
    for (final seg in segments) {
      if (seg.isEmpty || _containsInvalidKeyChars(seg)) {
        throw ArgumentError('Invalid child path ($childPath) for orderByChild.');
      }
    }
    return PyricQuery(
      database,
      path,
      orderBy: {'kind': 'child', 'path': segments.join('/')},
      bounds: _bounds,
      limit: _limit,
    );
  }

  /// Orders results lexicographically by child key name.
  PyricQuery orderByKey() {
    _requireNoOrderBy();
    for (final bound in _bounds) {
      if (bound.containsKey('key') && bound['key'] != null) {
        throw ArgumentError(
          "Can't pass a key cursor on an orderByKey() query!",
        );
      }
      if (bound['value'] is! String) {
        throw ArgumentError(
          'Query cursor value on an orderByKey() query must be a String.',
        );
      }
    }
    return PyricQuery(
      database,
      path,
      orderBy: const {'kind': 'key'},
      bounds: _bounds,
      limit: _limit,
    );
  }

  /// Orders results by direct scalar node values.
  PyricQuery orderByValue() {
    _requireNoOrderBy();
    return PyricQuery(
      database,
      path,
      orderBy: const {'kind': 'value'},
      bounds: _bounds,
      limit: _limit,
    );
  }

  /// Orders results by priority metadata.
  PyricQuery orderByPriority() {
    _requireNoOrderBy();
    return PyricQuery(
      database,
      path,
      orderBy: const {'kind': 'priority'},
      bounds: _bounds,
      limit: _limit,
    );
  }

  /// Filters results to nodes matching the exact sort [value] and optional [key].
  PyricQuery equalTo(Object? value, {String? key}) {
    final bound = _buildValidatedBound('equalTo', value, key: key);
    return PyricQuery(
      database,
      path,
      orderBy: _orderBy,
      bounds: [..._bounds, bound],
      limit: _limit,
    );
  }

  /// Restricts results to nodes with a sort value greater than or equal to [value].
  PyricQuery startAt(Object? value, {String? key}) {
    final bound = _buildValidatedBound('startAt', value, key: key);
    return PyricQuery(
      database,
      path,
      orderBy: _orderBy,
      bounds: [..._bounds, bound],
      limit: _limit,
    );
  }

  /// Restricts results to nodes with a sort value strictly greater than [value].
  PyricQuery startAfter(Object? value, {String? key}) {
    final bound = _buildValidatedBound('startAfter', value, key: key);
    return PyricQuery(
      database,
      path,
      orderBy: _orderBy,
      bounds: [..._bounds, bound],
      limit: _limit,
    );
  }

  /// Restricts results to nodes with a sort value less than or equal to [value].
  PyricQuery endAt(Object? value, {String? key}) {
    final bound = _buildValidatedBound('endAt', value, key: key);
    return PyricQuery(
      database,
      path,
      orderBy: _orderBy,
      bounds: [..._bounds, bound],
      limit: _limit,
    );
  }

  /// Restricts results to nodes with a sort value strictly less than [value].
  PyricQuery endBefore(Object? value, {String? key}) {
    final bound = _buildValidatedBound('endBefore', value, key: key);
    return PyricQuery(
      database,
      path,
      orderBy: _orderBy,
      bounds: [..._bounds, bound],
      limit: _limit,
    );
  }

  /// Caps results to the first [limit] ordered child nodes.
  PyricQuery limitToFirst(int limit) {
    if (limit <= 0) {
      throw ArgumentError('Limit must be a positive integer!');
    }
    if (_limit != null) {
      throw ArgumentError(
        "Can't call limitToFirst on query with previously set limit!",
      );
    }
    return PyricQuery(
      database,
      path,
      orderBy: _orderBy,
      bounds: _bounds,
      limit: {'kind': 'limitToFirst', 'n': limit},
    );
  }

  /// Caps results to the last [limit] ordered child nodes.
  PyricQuery limitToLast(int limit) {
    if (limit <= 0) {
      throw ArgumentError('Limit must be a positive integer!');
    }
    if (_limit != null) {
      throw ArgumentError(
        "Can't call limitToLast on query with previously set limit!",
      );
    }
    return PyricQuery(
      database,
      path,
      orderBy: _orderBy,
      bounds: _bounds,
      limit: {'kind': 'limitToLast', 'n': limit},
    );
  }

  /// Fetches a one-shot [PyricDataSnapshot] of the current data at this query's location.
  ///
  /// A path under `/.info` is answered by the client and never reaches the host.
  Future<PyricDataSnapshot> get() async {
    if (isInfoPath(path)) {
      return PyricDataSnapshot.fromWire(ref, database.connectionInfo.read(path));
    }
    final spec = toQuerySpec();
    final res = await database.op('rtdb.get', {
      'path': path,
      if (spec != null) 'query': spec,
    });
    if (res is Map) {
      return PyricDataSnapshot.fromWire(ref, Map<String, dynamic>.from(res));
    }
    return PyricDataSnapshot(
      ref: ref,
      key: ref.key,
      exists: false,
      value: null,
      priority: null,
      children: const [],
    );
  }

  /// Emits a [PyricDatabaseEvent] with full [PyricDataSnapshot] initially and on any change.
  Stream<PyricDatabaseEvent> get onValue {
    return _observeViewEvent(PyricDatabaseEventType.value);
  }

  /// Emits a [PyricDatabaseEvent] for each existing child and whenever a new child is added.
  Stream<PyricDatabaseEvent> get onChildAdded {
    return _observeViewEvent(PyricDatabaseEventType.childAdded);
  }

  /// Emits a [PyricDatabaseEvent] whenever an existing child node is modified.
  Stream<PyricDatabaseEvent> get onChildChanged {
    return _observeViewEvent(PyricDatabaseEventType.childChanged);
  }

  /// Emits a [PyricDatabaseEvent] whenever an existing child node's indexed sort value changes.
  Stream<PyricDatabaseEvent> get onChildMoved {
    return _observeViewEvent(PyricDatabaseEventType.childMoved);
  }

  /// Emits a [PyricDatabaseEvent] whenever a child node is removed from this location.
  Stream<PyricDatabaseEvent> get onChildRemoved {
    return _observeViewEvent(PyricDatabaseEventType.childRemoved);
  }

  Stream<PyricDatabaseEvent> _observeViewEvent(
    PyricDatabaseEventType targetType,
  ) {
    return database.viewCoordinator.observe(
      ref: ref,
      orderBy: _orderBy,
      querySpec: toQuerySpec(),
      eventType: targetType,
    );
  }
}

/// Type alias conforming to `firebase_database` naming.
typedef Query = PyricQuery;
