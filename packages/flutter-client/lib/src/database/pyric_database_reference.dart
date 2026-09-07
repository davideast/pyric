import 'dart:async';
import 'dart:math';

import 'pyric_data_snapshot.dart';
import 'pyric_database.dart';
import 'pyric_on_disconnect.dart';
import 'pyric_query.dart';
import 'pyric_transaction_result.dart';

/// Represents a reference to a specific location in the Realtime Database.
class PyricDatabaseReference extends PyricQuery {
  static const String _pushChars =
      '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  static int _lastPushTime = 0;
  static final List<int> _lastRandChars = List<int>.filled(12, 0);
  static final Random _random = Random();

  const PyricDatabaseReference(
    super.database,
    super.path,
  );

  /// Generates a chronologically ordered 20-character Firebase push ID.
  static String _generatePushId() {
    int now = DateTime.now().millisecondsSinceEpoch;
    final bool duplicateTime = (now == _lastPushTime);
    _lastPushTime = now;

    final List<String> timeStampChars = List<String>.filled(8, '');
    for (int i = 7; i >= 0; i--) {
      timeStampChars[i] = _pushChars[now % 64];
      now = now ~/ 64;
    }

    final StringBuffer id = StringBuffer(timeStampChars.join());

    if (!duplicateTime) {
      for (int i = 0; i < 12; i++) {
        _lastRandChars[i] = _random.nextInt(64);
      }
    } else {
      int i = 11;
      while (i >= 0 && _lastRandChars[i] == 63) {
        _lastRandChars[i] = 0;
        i--;
      }
      if (i >= 0) {
        _lastRandChars[i]++;
      }
    }

    for (int i = 0; i < 12; i++) {
      id.write(_pushChars[_lastRandChars[i]]);
    }

    return id.toString();
  }

  /// Returns a child [PyricDatabaseReference] relative to this reference's path.
  PyricDatabaseReference child(String childPath) {
    final segments = [
      ...path.split('/').where((s) => s.isNotEmpty),
      ...childPath.split('/').where((s) => s.isNotEmpty),
    ];
    final normalized = segments.isEmpty ? '/' : '/${segments.join('/')}';
    return PyricDatabaseReference(database, normalized);
  }

  /// Returns the parent [PyricDatabaseReference], or null if this is the root reference.
  PyricDatabaseReference? get parent {
    final segments = path.split('/').where((s) => s.isNotEmpty).toList();
    if (segments.isEmpty) return null;
    segments.removeLast();
    final parentPath = segments.isEmpty ? '/' : '/${segments.join('/')}';
    return PyricDatabaseReference(database, parentPath);
  }

  /// Returns the root [PyricDatabaseReference] of the Realtime Database.
  PyricDatabaseReference get root => PyricDatabaseReference(database, '/');

  /// Returns the last path segment token of this reference, or null for the root reference.
  String? get key {
    final segments = path.split('/').where((s) => s.isNotEmpty).toList();
    if (segments.isEmpty) return null;
    return segments.last;
  }

  /// Generates a new child [PyricDatabaseReference] with a chronologically ordered unique push ID.
  PyricDatabaseReference push() {
    final pushId = _generatePushId();
    return child(pushId);
  }

  /// Overwrites data at this reference path with [value]. Passing null deletes the data.
  Future<void> set(Object? value) async {
    await database.op('rtdb.set', {
      'path': path,
      'value': value,
    });
  }

  /// Updates the ordering priority metadata of the node without altering its value.
  Future<void> setPriority(Object? priority) async {
    await database.op('rtdb.setPriority', {
      'path': path,
      'priority': priority,
    });
  }

  /// Atomically writes the node [value] alongside its ordering [priority] metadata.
  Future<void> setWithPriority(Object? value, Object? priority) async {
    await database.op('rtdb.setWithPriority', {
      'path': path,
      'value': value,
      'priority': priority,
    });
  }

  /// Performs a multi-path atomic update of specified child keys without overwriting omitted siblings.
  Future<void> update(Map<String, Object?> values) async {
    await database.op('rtdb.update', {
      'path': path,
      'values': values,
    });
  }

  /// Removes the node and all descendant data at this reference path.
  Future<void> remove() async {
    await database.op('rtdb.remove', {
      'path': path,
    });
  }

  /// Executes an optimistic concurrency transaction at this reference path.
  Future<PyricTransactionResult> runTransaction(
    PyricTransactionHandler transactionHandler, {
    bool applyLocally = true,
    int maxAttempts = 25,
  }) async {
    int attempts = 0;
    while (true) {
      attempts++;
      final currentSnap = await get();
      final mutableData = PyricMutableData(
        key: key,
        value: currentSnap.value,
        priority: currentSnap.priority,
      );

      final handlerResult = await transactionHandler(mutableData);
      if (handlerResult.aborted) {
        return PyricTransactionResult(
          committed: false,
          snapshot: currentSnap,
        );
      }

      final res = await database.op('rtdb.transactionCommit', {
        'path': path,
        'expected': currentSnap.value,
        'value': mutableData.value,
        'applyLocally': applyLocally,
      });

      if (res is Map) {
        final retry = res['retry'] == true;
        if (retry && attempts < maxAttempts) {
          continue;
        }
        final committed = res['committed'] == true;
        final snapMap = res['snapshot'] is Map
            ? Map<String, dynamic>.from(res['snapshot'] as Map)
            : <String, dynamic>{
                'key': key,
                'exists': mutableData.value != null,
                'value': mutableData.value,
                'priority': mutableData.priority,
              };
        return PyricTransactionResult(
          committed: committed,
          snapshot: PyricDataSnapshot.fromWire(this, snapMap),
        );
      }

      return PyricTransactionResult(
        committed: true,
        snapshot: currentSnap,
      );
    }
  }

  /// Returns a [PyricOnDisconnect] handle for queuing server-side disconnect operations at this path.
  PyricOnDisconnect onDisconnect() => PyricOnDisconnect(
        database: database,
        path: path,
      );
}

/// Type alias conforming to `firebase_database` naming.
typedef DatabaseReference = PyricDatabaseReference;
