import 'pyric_database.dart';

/// Queues server-side write or removal operations to execute when the client disconnects.
class PyricOnDisconnect {
  final PyricDatabase database;
  final String path;

  const PyricOnDisconnect({
    required this.database,
    required this.path,
  });

  /// Registers a server-side write at [path] to execute upon disconnect.
  Future<void> set(Object? value) async {
    await database.op('rtdb.onDisconnectSet', {
      'path': path,
      'value': value,
    });
  }

  /// Registers a server-side write with ordering priority at [path] upon disconnect.
  Future<void> setWithPriority(Object? value, Object? priority) async {
    await database.op('rtdb.onDisconnectSet', {
      'path': path,
      'value': value,
      'priority': priority,
    });
  }

  /// Registers a multi-path update at [path] to execute upon disconnect.
  Future<void> update(Map<String, Object?> values) async {
    await database.op('rtdb.onDisconnectUpdate', {
      'path': path,
      'values': values,
    });
  }

  /// Registers a removal operation at [path] to execute upon disconnect.
  Future<void> remove() async {
    await database.op('rtdb.onDisconnectRemove', {
      'path': path,
    });
  }

  /// Cancels all previously queued disconnect operations at [path].
  Future<void> cancel() async {
    await database.op('rtdb.onDisconnectCancel', {
      'path': path,
    });
  }
}

/// Type alias conforming to `firebase_database` naming.
typedef OnDisconnect = PyricOnDisconnect;
