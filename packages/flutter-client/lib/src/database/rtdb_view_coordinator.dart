import 'dart:async';
import 'dart:convert';

import 'package:collection/collection.dart';

import 'pyric_data_snapshot.dart';
import 'pyric_database.dart';
import 'pyric_database_reference.dart';

/// Canonical Firebase RTDB `EventGenerator` dispatch order within a query view.
const List<PyricDatabaseEventType> canonicalRtdbEventOrder =
    <PyricDatabaseEventType>[
  PyricDatabaseEventType.childRemoved,
  PyricDatabaseEventType.childAdded,
  PyricDatabaseEventType.childMoved,
  PyricDatabaseEventType.childChanged,
  PyricDatabaseEventType.value,
];

/// Computes child and value events for a single listener registration in
/// Firebase RTDB `EventGenerator` order.
class RtdbSnapshotDiffer {
  final PyricDatabaseEventType targetType;
  final Map<String, dynamic>? orderBy;

  List<PyricDataSnapshot> _previousChildren = const <PyricDataSnapshot>[];
  bool _isFirstSnapshot = true;

  RtdbSnapshotDiffer({
    required this.targetType,
    required this.orderBy,
  });

  List<PyricDatabaseEvent> collectEvents(PyricDataSnapshot snap) {
    final events = <PyricDatabaseEvent>[];
    final newChildren = snap.children.toList();

    if (_isFirstSnapshot) {
      _isFirstSnapshot = false;
      if (targetType == PyricDatabaseEventType.childAdded) {
        String? prevKey;
        for (final child in newChildren) {
          events.add(
            PyricDatabaseEvent(
              type: PyricDatabaseEventType.childAdded,
              snapshot: child,
              previousChildKey: prevKey,
            ),
          );
          prevKey = child.key;
        }
      }
      _previousChildren = newChildren;
      if (targetType == PyricDatabaseEventType.value) {
        events.add(
          PyricDatabaseEvent(
            type: PyricDatabaseEventType.value,
            snapshot: snap,
          ),
        );
      }
      return events;
    }

    final oldChildren = _previousChildren;
    _previousChildren = newChildren;

    if (targetType == PyricDatabaseEventType.value) {
      events.add(
        PyricDatabaseEvent(
          type: PyricDatabaseEventType.value,
          snapshot: snap,
        ),
      );
      return events;
    }

    final oldByKey = <String, PyricDataSnapshot>{
      for (final c in oldChildren)
        if (c.key != null) c.key!: c,
    };
    final newByKey = <String, PyricDataSnapshot>{
      for (final c in newChildren)
        if (c.key != null) c.key!: c,
    };
    final prevKeyByChild = <String, String?>{};
    String? runningPrevKey;
    for (final child in newChildren) {
      final k = child.key;
      if (k != null) {
        prevKeyByChild[k] = runningPrevKey;
        runningPrevKey = k;
      }
    }

    if (targetType == PyricDatabaseEventType.childRemoved) {
      for (final oldChild in oldChildren) {
        final k = oldChild.key;
        if (k != null && !newByKey.containsKey(k)) {
          events.add(
            PyricDatabaseEvent(
              type: PyricDatabaseEventType.childRemoved,
              snapshot: oldChild,
            ),
          );
        }
      }
      return events;
    }

    if (targetType == PyricDatabaseEventType.childAdded) {
      for (final newChild in newChildren) {
        final k = newChild.key;
        if (k != null && !oldByKey.containsKey(k)) {
          events.add(
            PyricDatabaseEvent(
              type: PyricDatabaseEventType.childAdded,
              snapshot: newChild,
              previousChildKey: prevKeyByChild[k],
            ),
          );
        }
      }
      return events;
    }

    if (targetType == PyricDatabaseEventType.childMoved) {
      for (final newChild in newChildren) {
        final k = newChild.key;
        if (k == null) continue;
        final oldChild = oldByKey[k];
        if (oldChild != null &&
            _hasChildMutated(oldChild, newChild) &&
            _didIndexedSortValueChange(oldChild, newChild)) {
          events.add(
            PyricDatabaseEvent(
              type: PyricDatabaseEventType.childMoved,
              snapshot: newChild,
              previousChildKey: prevKeyByChild[k],
            ),
          );
        }
      }
      return events;
    }

    if (targetType == PyricDatabaseEventType.childChanged) {
      for (final newChild in newChildren) {
        final k = newChild.key;
        if (k == null) continue;
        final oldChild = oldByKey[k];
        if (oldChild != null && _hasChildMutated(oldChild, newChild)) {
          events.add(
            PyricDatabaseEvent(
              type: PyricDatabaseEventType.childChanged,
              snapshot: newChild,
              previousChildKey: prevKeyByChild[k],
            ),
          );
        }
      }
    }

    return events;
  }

  bool _hasChildMutated(PyricDataSnapshot oldChild, PyricDataSnapshot newChild) {
    return !_rtdbValuesEqual(oldChild.value, newChild.value) ||
        !_rtdbScalarsEqual(oldChild.priority, newChild.priority);
  }

  bool _didIndexedSortValueChange(
    PyricDataSnapshot oldChild,
    PyricDataSnapshot newChild,
  ) {
    final kind = orderBy?['kind'] as String? ?? 'priority';
    switch (kind) {
      case 'key':
        return false;
      case 'priority':
        return !_rtdbScalarsEqual(oldChild.priority, newChild.priority);
      case 'value':
        if (!_rtdbValuesEqual(oldChild.value, newChild.value)) {
          return true;
        }
        return !_rtdbScalarsEqual(oldChild.priority, newChild.priority);
      case 'child':
        final childPath = orderBy?['path'] as String?;
        if (childPath == null || childPath.isEmpty) {
          return false;
        }
        final oldLeaf = _pathIndexLeaf(oldChild.child(childPath).value);
        final newLeaf = _pathIndexLeaf(newChild.child(childPath).value);
        return !_rtdbScalarsEqual(oldLeaf, newLeaf);
      default:
        return !_rtdbScalarsEqual(oldChild.priority, newChild.priority);
    }
  }

  static Object? _pathIndexLeaf(Object? raw) {
    if (raw is Map || raw is List) {
      return null;
    }
    return raw;
  }

  static bool _rtdbScalarsEqual(Object? left, Object? right) {
    if (identical(left, right)) return true;
    if (left == null || right == null) return false;
    if (left is bool && right is bool) return left == right;
    if (left is String && right is String) return left == right;
    if (left is num && right is num) {
      if (left.isNaN || right.isNaN) return false;
      if (left is int && right is int) return left == right;
      if (left is double && right is double) return left == right;
      if (left is int && right is double) {
        if (right.isInfinite || right != right.truncateToDouble()) return false;
        return right.toInt() == left && left.toDouble() == right;
      }
      if (left is double && right is int) {
        if (left.isInfinite || left != left.truncateToDouble()) return false;
        return left.toInt() == right && right.toDouble() == left;
      }
      return left == right;
    }
    return false;
  }

  static bool _rtdbValuesEqual(Object? left, Object? right) {
    if (_rtdbScalarsEqual(left, right)) return true;
    if (left is List && right is List) {
      if (left.length != right.length) return false;
      for (int i = 0; i < left.length; i++) {
        if (!_rtdbValuesEqual(left[i], right[i])) return false;
      }
      return true;
    }
    if (left is Map && right is Map) {
      if (left.length != right.length) return false;
      for (final entry in left.entries) {
        if (!right.containsKey(entry.key)) return false;
        if (!_rtdbValuesEqual(entry.value, right[entry.key])) return false;
      }
      return true;
    }
    return const DeepCollectionEquality().equals(left, right);
  }
}

class _ObserverRegistration {
  final int id;
  final RtdbSnapshotDiffer differ;
  final StreamController<PyricDatabaseEvent> controller;
  bool active = true;

  _ObserverRegistration({
    required this.id,
    required this.differ,
    required this.controller,
  });
}

class _ActiveRtdbView {
  final String key;
  final PyricDatabase database;
  final PyricDatabaseReference ref;
  final Map<String, dynamic>? querySpec;
  final void Function(String key, _ActiveRtdbView view) onEmpty;

  final List<_ObserverRegistration> _registrations = <_ObserverRegistration>[];
  StreamSubscription<dynamic>? _sub;
  PyricDataSnapshot? _latestSnapshot;

  _ActiveRtdbView({
    required this.key,
    required this.database,
    required this.ref,
    required this.querySpec,
    required this.onEmpty,
  });

  void addRegistration(_ObserverRegistration reg) {
    _registrations.add(reg);
    final cached = _latestSnapshot;
    if (cached != null) {
      final initialEvents = reg.differ.collectEvents(cached);
      if (initialEvents.isNotEmpty) {
        scheduleMicrotask(() {
          if (!reg.active || reg.controller.isClosed) return;
          for (final ev in initialEvents) {
            if (!reg.active || reg.controller.isClosed) break;
            reg.controller.add(ev);
          }
        });
      }
    }
    _sub ??= database.subscribeRtdb(ref.path, querySpec: querySpec).listen(
      _handleRawEvent,
      onError: _handleError,
    );
  }

  Future<void> removeRegistration(_ObserverRegistration reg) async {
    reg.active = false;
    _registrations.remove(reg);
    if (_registrations.isEmpty) {
      _latestSnapshot = null;
      final sub = _sub;
      _sub = null;
      onEmpty(key, this);
      await sub?.cancel();
    }
  }

  void _handleRawEvent(dynamic rawEvent) {
    final snap = rawEvent is Map
        ? PyricDataSnapshot.fromWire(ref, Map<String, dynamic>.from(rawEvent))
        : PyricDataSnapshot(
            ref: ref,
            key: ref.key,
            exists: false,
            value: null,
            priority: null,
            children: const <PyricDataSnapshot>[],
          );
    _latestSnapshot = snap;

    final snapshotRegs = List<_ObserverRegistration>.from(_registrations);
    final batches = <(_ObserverRegistration, List<PyricDatabaseEvent>)>[];
    for (final reg in snapshotRegs) {
      if (!reg.active) continue;
      final evs = reg.differ.collectEvents(snap);
      if (evs.isNotEmpty) {
        batches.add((reg, evs));
      }
    }

    for (final kind in canonicalRtdbEventOrder) {
      for (final (reg, evs) in batches) {
        if (!reg.active || reg.controller.isClosed) continue;
        for (final ev in evs) {
          if (ev.type == kind && reg.active && !reg.controller.isClosed) {
            reg.controller.add(ev);
          }
        }
      }
    }
  }

  void _handleError(Object error, StackTrace stackTrace) {
    _latestSnapshot = null;
    final snapshotRegs = List<_ObserverRegistration>.from(_registrations);
    for (final reg in snapshotRegs) {
      if (reg.active && !reg.controller.isClosed) {
        reg.controller.addError(error, stackTrace);
      }
    }
  }
}

/// Coordinates active RTDB stream listeners per `(path, querySpec)` view on a
/// [PyricDatabase] instance so child and value events fan out in canonical
/// Firebase `EventGenerator` order.
class RtdbViewCoordinator {
  final PyricDatabase _database;
  final Map<String, _ActiveRtdbView> _views = <String, _ActiveRtdbView>{};
  int _nextId = 1;

  RtdbViewCoordinator(this._database);

  Stream<PyricDatabaseEvent> observe({
    required PyricDatabaseReference ref,
    required Map<String, dynamic>? orderBy,
    required Map<String, dynamic>? querySpec,
    required PyricDatabaseEventType eventType,
  }) {
    late StreamController<PyricDatabaseEvent> controller;
    _ObserverRegistration? activeReg;
    _ActiveRtdbView? boundView;

    controller = StreamController<PyricDatabaseEvent>.broadcast(
      sync: true,
      onListen: () {
        final key = _buildViewKey(ref.path, querySpec);
        final view = _views.putIfAbsent(
          key,
          () => _ActiveRtdbView(
            key: key,
            database: _database,
            ref: ref,
            querySpec: querySpec,
            onEmpty: (k, v) {
              if (identical(_views[k], v)) {
                _views.remove(k);
              }
            },
          ),
        );
        final reg = _ObserverRegistration(
          id: _nextId++,
          differ: RtdbSnapshotDiffer(targetType: eventType, orderBy: orderBy),
          controller: controller,
        );
        boundView = view;
        activeReg = reg;
        view.addRegistration(reg);
      },
      onCancel: () async {
        final reg = activeReg;
        final view = boundView;
        activeReg = null;
        boundView = null;
        if (reg != null && view != null) {
          await view.removeRegistration(reg);
        }
      },
    );

    return controller.stream;
  }

  static String _buildViewKey(String path, Map<String, dynamic>? querySpec) {
    if (querySpec == null) {
      return path;
    }
    return '$path|${jsonEncode(_canonicalizeJson(querySpec))}';
  }

  static Object? _canonicalizeJson(Object? value) {
    if (value is Map) {
      final sortedKeys = value.keys.map((k) => k.toString()).toList()..sort();
      return <String, Object?>{
        for (final k in sortedKeys) k: _canonicalizeJson(value[k]),
      };
    }
    if (value is List) {
      return <Object?>[for (final item in value) _canonicalizeJson(item)];
    }
    return value;
  }
}
