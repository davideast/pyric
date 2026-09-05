/// Domain model representing a Todo item in Firestore.
class TodoItem {
  final String id;
  final String title;
  final bool completed;
  final String userId;
  final DateTime? createdAt;

  const TodoItem({
    required this.id,
    required this.title,
    this.completed = false,
    this.userId = '',
    this.createdAt,
  });

  /// Deserializes a document snapshot into a TodoItem.
  factory TodoItem.fromMap(String id, Map<String, dynamic> data) {
    DateTime? parsedDate;
    final rawDate = data['createdAt'];
    if (rawDate is DateTime) {
      parsedDate = rawDate;
    } else if (rawDate is Map && rawDate['_seconds'] is num) {
      final seconds = (rawDate['_seconds'] as num).toInt();
      parsedDate = DateTime.fromMillisecondsSinceEpoch(seconds * 1000);
    } else if (rawDate is String) {
      parsedDate = DateTime.tryParse(rawDate);
    }

    final isDoneVal = data['completed'] ?? data['isDone'] ?? data['done'] ?? false;

    return TodoItem(
      id: id,
      title: data['title'] as String? ?? '',
      completed: isDoneVal is bool ? isDoneVal : false,
      userId: data['userId'] as String? ?? '',
      createdAt: parsedDate,
    );
  }

  /// Serializes into a Firestore map.
  Map<String, dynamic> toMap() {
    return {
      'title': title,
      'completed': completed,
      'userId': userId,
      'createdAt': createdAt?.toIso8601String(),
    };
  }
}
