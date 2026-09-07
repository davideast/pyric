import 'dart:async';

import 'package:collection/collection.dart';

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
  Future<PyricDataSnapshot> get() async {
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
    return database
        .subscribeRtdb(path, querySpec: toQuerySpec())
        .map((rawEvent) {
      final snap = rawEvent is Map
          ? PyricDataSnapshot.fromWire(
              ref,
              Map<String, dynamic>.from(rawEvent),
            )
          : PyricDataSnapshot(
              ref: ref,
              key: ref.key,
              exists: false,
              value: null,
              priority: null,
              children: const [],
            );
      return PyricDatabaseEvent(
        type: PyricDatabaseEventType.value,
        snapshot: snap,
      );
    });
  }

  /// Emits a [PyricDatabaseEvent] for each existing child and whenever a new child is added.
  Stream<PyricDatabaseEvent> get onChildAdded {
    return _transformChildEvents(PyricDatabaseEventType.childAdded);
  }

  /// Emits a [PyricDatabaseEvent] whenever an existing child node is modified.
  Stream<PyricDatabaseEvent> get onChildChanged {
    return _transformChildEvents(PyricDatabaseEventType.childChanged);
  }

  /// Emits a [PyricDatabaseEvent] whenever a child node is removed from this location.
  Stream<PyricDatabaseEvent> get onChildRemoved {
    return _transformChildEvents(PyricDatabaseEventType.childRemoved);
  }

  Stream<PyricDatabaseEvent> _transformChildEvents(
    PyricDatabaseEventType targetType,
  ) {
    late StreamController<PyricDatabaseEvent> controller;
    StreamSubscription<PyricDatabaseEvent>? sub;
    Map<String, PyricDataSnapshot>? previousChildren;

    controller = StreamController<PyricDatabaseEvent>.broadcast(
      onListen: () {
        previousChildren = null;
        sub = onValue.listen(
          (event) {
            final snap = event.snapshot;
            final currentList = snap.children.toList();
            final currentMap = <String, PyricDataSnapshot>{
              for (final c in currentList)
                if (c.key != null) c.key!: c,
            };

            if (previousChildren == null) {
              // Initial snapshot
              previousChildren = currentMap;
              if (targetType == PyricDatabaseEventType.childAdded) {
                String? prevKey;
                for (final child in currentList) {
                  controller.add(
                    PyricDatabaseEvent(
                      type: PyricDatabaseEventType.childAdded,
                      snapshot: child,
                      previousChildKey: prevKey,
                    ),
                  );
                  prevKey = child.key;
                }
              }
              return;
            }

            final prevMap = previousChildren!;
            previousChildren = currentMap;

            if (targetType == PyricDatabaseEventType.childAdded) {
              String? prevKey;
              for (final child in currentList) {
                final k = child.key;
                if (k != null && !prevMap.containsKey(k)) {
                  controller.add(
                    PyricDatabaseEvent(
                      type: PyricDatabaseEventType.childAdded,
                      snapshot: child,
                      previousChildKey: prevKey,
                    ),
                  );
                }
                prevKey = k;
              }
            } else if (targetType == PyricDatabaseEventType.childChanged) {
              const eq = DeepCollectionEquality();
              String? prevKey;
              for (final child in currentList) {
                final k = child.key;
                if (k != null && prevMap.containsKey(k)) {
                  final oldChild = prevMap[k]!;
                  final valChanged = !eq.equals(oldChild.value, child.value);
                  final prioChanged = oldChild.priority != child.priority;
                  if (valChanged || prioChanged) {
                    controller.add(
                      PyricDatabaseEvent(
                        type: PyricDatabaseEventType.childChanged,
                        snapshot: child,
                        previousChildKey: prevKey,
                      ),
                    );
                  }
                }
                prevKey = k;
              }
            } else if (targetType == PyricDatabaseEventType.childRemoved) {
              for (final entry in prevMap.entries) {
                if (!currentMap.containsKey(entry.key)) {
                  controller.add(
                    PyricDatabaseEvent(
                      type: PyricDatabaseEventType.childRemoved,
                      snapshot: entry.value,
                    ),
                  );
                }
              }
            }
          },
          onError: (Object err, StackTrace st) {
            controller.addError(err, st);
          },
        );
      },
      onCancel: () async {
        await sub?.cancel();
        sub = null;
        previousChildren = null;
      },
    );

    return controller.stream;
  }
}

/// Type alias conforming to `firebase_database` naming.
typedef Query = PyricQuery;
