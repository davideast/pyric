import 'dart:async';
import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import 'package:flutter/foundation.dart';
import 'package:pyric_firestore/pyric_database.dart';
import '../models/todo_item.dart';

enum DatabaseEngine {
  rtdb('Realtime Database (RTDB)'),
  firestore('Cloud Firestore');

  final String label;
  const DatabaseEngine(this.label);
}

/// Repository managing both Realtime Database (RTDB) and Firestore operations for the Todo app.
class TodoRepository {
  final FirebaseFirestorePlatform _firestore;
  final PyricDatabase _rtdb;
  final ValueNotifier<DatabaseEngine> engineNotifier =
      ValueNotifier<DatabaseEngine>(DatabaseEngine.rtdb);

  TodoRepository({
    FirebaseFirestorePlatform? firestore,
    PyricDatabase? rtdb,
  })  : _firestore = firestore ?? FirebaseFirestorePlatform.instance,
        _rtdb = rtdb ?? PyricDatabase.instance;

  DatabaseEngine get currentEngine => engineNotifier.value;

  void setEngine(DatabaseEngine engine) {
    if (engineNotifier.value != engine) {
      engineNotifier.value = engine;
    }
  }

  /// Emits real-time stream of todos filtered by user ID from the active database engine.
  Stream<List<TodoItem>> getTodosStream(String userId) {
    if (currentEngine == DatabaseEngine.rtdb) {
      return _rtdb
          .ref('todos')
          .orderByChild('userId')
          .equalTo(userId)
          .onValue
          .map((event) {
        final raw = event.snapshot.value;
        if (raw == null || raw is! Map) return <TodoItem>[];
        final map = Map<String, dynamic>.from(raw);
        final items = map.entries.map((entry) {
          final valueMap = entry.value is Map
              ? Map<String, dynamic>.from(entry.value as Map)
              : <String, dynamic>{};
          return TodoItem.fromMap(entry.key, valueMap);
        }).toList();

        items.sort((a, b) {
          if (a.createdAt == null) return 1;
          if (b.createdAt == null) return -1;
          return b.createdAt!.compareTo(a.createdAt!);
        });

        return items;
      });
    }

    return _firestore
        .collection('todos')
        .where([
          ['userId', '==', userId]
        ])
        .snapshots(listenSource: ListenSource.defaultSource)
        .map((snapshot) {
      final items = snapshot.docs.map((doc) {
        return TodoItem.fromMap(doc.id, doc.data() ?? {});
      }).toList();

      items.sort((a, b) {
        if (a.createdAt == null) return 1;
        if (b.createdAt == null) return -1;
        return b.createdAt!.compareTo(a.createdAt!);
      });

      return items;
    });
  }

  /// Adds a new todo item stamped with the current user ID.
  Future<void> addTodo(String title, String userId) async {
    final trimmed = title.trim();
    if (trimmed.isEmpty) return;

    if (currentEngine == DatabaseEngine.rtdb) {
      final newRef = _rtdb.ref('todos').push();
      await newRef.set({
        'title': trimmed,
        'completed': false,
        'userId': userId,
        'createdAt': DateTime.now().millisecondsSinceEpoch,
      });
      return;
    }

    final docRef = _firestore.collection('todos').doc();
    await docRef.set({
      'title': trimmed,
      'completed': false,
      'userId': userId,
      'createdAt': FieldValueFactoryPlatform.instance.serverTimestamp(),
    });
  }

  /// Deliberately attempts an unauthorized write (mismatched userId) to verify security rules.
  Future<void> triggerUnauthorizedWrite() async {
    if (currentEngine == DatabaseEngine.rtdb) {
      final newRef = _rtdb.ref('todos').push();
      await newRef.set({
        'title': 'Unauthorized Hacker Todo (RTDB)',
        'completed': false,
        'userId': 'attacker-wrong-uid-999',
        'createdAt': DateTime.now().millisecondsSinceEpoch,
      });
      return;
    }

    final docRef = _firestore.collection('todos').doc();
    await docRef.set({
      'title': 'Unauthorized Hacker Todo',
      'completed': false,
      'userId': 'attacker-wrong-uid-999',
      'createdAt': FieldValueFactoryPlatform.instance.serverTimestamp(),
    });
  }

  /// Toggles the completed status of a todo item.
  Future<void> toggleTodo(String id, bool completed) async {
    if (currentEngine == DatabaseEngine.rtdb) {
      await _rtdb.ref('todos/$id').update({
        'completed': !completed,
      });
      return;
    }

    await _firestore.collection('todos').doc(id).update({
      FieldPath(const ['completed']): !completed,
    });
  }

  /// Deletes a todo item from the active database engine.
  Future<void> deleteTodo(String id) async {
    if (currentEngine == DatabaseEngine.rtdb) {
      await _rtdb.ref('todos/$id').remove();
      return;
    }

    await _firestore.collection('todos').doc(id).delete();
  }
}
