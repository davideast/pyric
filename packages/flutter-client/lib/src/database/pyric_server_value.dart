/// Server-side sentinel values for Realtime Database write operations.
class PyricServerValue {
  const PyricServerValue._();

  /// Sentinel value that resolves to the current server epoch timestamp in milliseconds.
  static const Map<String, dynamic> timestamp = {
    '__rtdbSentinel': 'serverTimestamp',
    '.sv': 'timestamp',
  };

  /// Sentinel value that atomically increments the numeric value at the target path by [delta].
  static Map<String, dynamic> increment(num delta) => {
        '__rtdbSentinel': 'increment',
        'delta': delta,
        '.sv': {'increment': delta},
      };
}

/// Type alias conforming to standard `firebase_database` naming.
typedef ServerValue = PyricServerValue;
