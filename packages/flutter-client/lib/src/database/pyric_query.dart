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

  /// Orders results by the value of the specified nested child [childPath].
  PyricQuery orderByChild(String childPath) {
    final cleanPath = childPath.split('/').where((s) => s.isNotEmpty).join('/');
    return PyricQuery(
      database,
      path,
      orderBy: {'kind': 'child', 'path': cleanPath},
      bounds: _bounds,
      limit: _limit,
    );
  }

  /// Orders results lexicographically by child key name.
  PyricQuery orderByKey() {
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
    return PyricQuery(
      database,
      path,
      orderBy: _orderBy,
      bounds: [
        ..._bounds,
        {
          'kind': 'equalTo',
          'value': value,
          if (key != null) 'key': key,
        },
      ],
      limit: _limit,
    );
  }

  /// Restricts results to nodes with a sort value greater than or equal to [value].
  PyricQuery startAt(Object? value, {String? key}) {
    return PyricQuery(
      database,
      path,
      orderBy: _orderBy,
      bounds: [
        ..._bounds,
        {
          'kind': 'startAt',
          'value': value,
          if (key != null) 'key': key,
        },
      ],
      limit: _limit,
    );
  }

  /// Restricts results to nodes with a sort value strictly greater than [value].
  PyricQuery startAfter(Object? value, {String? key}) {
    return PyricQuery(
      database,
      path,
      orderBy: _orderBy,
      bounds: [
        ..._bounds,
        {
          'kind': 'startAfter',
          'value': value,
          if (key != null) 'key': key,
        },
      ],
      limit: _limit,
    );
  }

  /// Restricts results to nodes with a sort value less than or equal to [value].
  PyricQuery endAt(Object? value, {String? key}) {
    return PyricQuery(
      database,
      path,
      orderBy: _orderBy,
      bounds: [
        ..._bounds,
        {
          'kind': 'endAt',
          'value': value,
          if (key != null) 'key': key,
        },
      ],
      limit: _limit,
    );
  }

  /// Restricts results to nodes with a sort value strictly less than [value].
  PyricQuery endBefore(Object? value, {String? key}) {
    return PyricQuery(
      database,
      path,
      orderBy: _orderBy,
      bounds: [
        ..._bounds,
        {
          'kind': 'endBefore',
          'value': value,
          if (key != null) 'key': key,
        },
      ],
      limit: _limit,
    );
  }

  /// Caps results to the first [limit] ordered child nodes.
  PyricQuery limitToFirst(int limit) {
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
