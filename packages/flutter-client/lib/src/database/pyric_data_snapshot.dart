import 'pyric_database_reference.dart';

/// Represents the event type emitted by Realtime Database stream listeners.
enum PyricDatabaseEventType {
  /// Emitted for `onValue` listeners.
  value,

  /// Emitted when a child node is added.
  childAdded,

  /// Emitted when an existing child node is modified.
  childChanged,

  /// Emitted when a child node is removed.
  childRemoved,
}

/// Type alias conforming to `firebase_database` naming.
typedef DatabaseEventType = PyricDatabaseEventType;

/// Encapsulates a Realtime Database event emitted by `onValue` or child listeners.
class PyricDatabaseEvent {
  final PyricDatabaseEventType type;
  final PyricDataSnapshot snapshot;
  final String? previousChildKey;

  const PyricDatabaseEvent({
    required this.type,
    required this.snapshot,
    this.previousChildKey,
  });
}

/// Type alias conforming to `firebase_database` naming.
typedef DatabaseEvent = PyricDatabaseEvent;

/// Contains data read from a Realtime Database location at a specific point in time.
class PyricDataSnapshot {
  final PyricDatabaseReference ref;
  final String? _key;
  final bool _exists;
  final Object? _value;
  final Object? _priority;
  final List<PyricDataSnapshot> _children;

  const PyricDataSnapshot({
    required this.ref,
    required String? key,
    required bool exists,
    required Object? value,
    required Object? priority,
    required List<PyricDataSnapshot> children,
  })  : _key = key,
        _exists = exists,
        _value = value,
        _priority = priority,
        _children = children;

  /// Deserializes a [PyricDataSnapshot] from the Pyric worker wire envelope.
  factory PyricDataSnapshot.fromWire(
    PyricDatabaseReference ref,
    Map<String, dynamic> wire,
  ) {
    final exists = wire['exists'] == true;
    final key = wire['key'] as String? ?? ref.key;
    final value = wire['value'];
    final priority = wire['priority'];

    final List<PyricDataSnapshot> childSnapshots = [];
    final entriesRaw = wire['entries'];
    if (entriesRaw is List) {
      for (final item in entriesRaw) {
        if (item is Map) {
          final entry = Map<String, dynamic>.from(item);
          final childKey = entry['key'] as String?;
          if (childKey != null) {
            final childRef = ref.child(childKey);
            final childVal = entry['value'];
            final childPrio = entry['priority'];
            childSnapshots.add(
              PyricDataSnapshot._fromNode(
                ref: childRef,
                key: childKey,
                value: childVal,
                priority: childPrio,
              ),
            );
          }
        }
      }
    } else if (value is Map) {
      for (final entry in value.entries) {
        final childKey = entry.key.toString();
        final childRef = ref.child(childKey);
        childSnapshots.add(
          PyricDataSnapshot._fromNode(
            ref: childRef,
            key: childKey,
            value: entry.value,
            priority: null,
          ),
        );
      }
    }

    return PyricDataSnapshot(
      ref: ref,
      key: key,
      exists: exists,
      value: value,
      priority: priority,
      children: childSnapshots,
    );
  }

  factory PyricDataSnapshot._fromNode({
    required PyricDatabaseReference ref,
    required String? key,
    required Object? value,
    required Object? priority,
  }) {
    final exists = value != null;
    final List<PyricDataSnapshot> childSnapshots = [];
    if (value is Map) {
      for (final entry in value.entries) {
        final childKey = entry.key.toString();
        childSnapshots.add(
          PyricDataSnapshot._fromNode(
            ref: ref.child(childKey),
            key: childKey,
            value: entry.value,
            priority: null,
          ),
        );
      }
    }
    return PyricDataSnapshot(
      ref: ref,
      key: key,
      exists: exists,
      value: value,
      priority: priority,
      children: childSnapshots,
    );
  }

  /// The key name of the location that generated this snapshot, or null for the root.
  String? get key => _key;

  /// Returns true if this snapshot contains non-null data.
  bool get exists => _exists;

  /// Returns the deserialized Dart value (Map, List, String, num, bool, or null) of this snapshot.
  Object? get value => _value;

  /// Returns the priority value associated with this node.
  Object? get priority => _priority;

  /// Returns an ordered iterable of direct child [PyricDataSnapshot]s.
  Iterable<PyricDataSnapshot> get children => _children;

  /// Returns a [PyricDataSnapshot] for the relative descendant [path].
  PyricDataSnapshot child(String path) {
    final segments = path.split('/').where((s) => s.isNotEmpty).toList();
    if (segments.isEmpty) return this;

    PyricDataSnapshot current = this;
    for (final segment in segments) {
      final match = current._children.where((c) => c.key == segment).firstOrNull;
      if (match != null) {
        current = match;
      } else {
        Object? nestedVal;
        if (current._value is Map) {
          nestedVal = (current._value as Map)[segment];
        }
        current = PyricDataSnapshot._fromNode(
          ref: current.ref.child(segment),
          key: segment,
          value: nestedVal,
          priority: null,
        );
      }
    }
    return current;
  }
}

/// Type alias conforming to `firebase_database` naming.
typedef DataSnapshot = PyricDataSnapshot;
