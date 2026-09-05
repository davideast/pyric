import 'dart:async';
import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import '../models/todo_item.dart';

/// Repository managing Firestore operations for the Todo app.
class TodoRepository {
  final FirebaseFirestorePlatform _firestore;

  TodoRepository({FirebaseFirestorePlatform? firestore})
      : _firestore = firestore ?? FirebaseFirestorePlatform.instance;

  /// Emits real-time stream of todos filtered by user ID.
  Stream<List<TodoItem>> getTodosStream(String userId) {
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

  /// Adds a new todo document stamped with the current user ID.
  Future<void> addTodo(String title, String userId) async {
    final trimmed = title.trim();
    if (trimmed.isEmpty) return;

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
    final docRef = _firestore.collection('todos').doc();
    await docRef.set({
      'title': 'Unauthorized Hacker Todo',
      'completed': false,
      'userId': 'attacker-wrong-uid-999',
      'createdAt': FieldValueFactoryPlatform.instance.serverTimestamp(),
    });
  }

  /// Toggles the completed status of a todo document.
  Future<void> toggleTodo(String id, bool completed) async {
    await _firestore.collection('todos').doc(id).update({
      FieldPath(const ['completed']): !completed,
    });
  }

  /// Deletes a todo document from Firestore.
  Future<void> deleteTodo(String id) async {
    await _firestore.collection('todos').doc(id).delete();
  }
}
