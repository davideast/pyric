import 'codecs.dart' show encodeValue;

// ─── Sentinels & Transformations ────────────────────────────────────────────

/// Abstract marker for FieldValue sentinels serialized across the Pyric wire.
abstract class PyricSentinel {
  const PyricSentinel();

  /// Convert sentinel into wire format (`{'__sentinel': ...}`).
  Map<String, dynamic> toWireSentinel();
}

/// Sentinel that requests server commit timestamp during write.
class PyricServerTimestampSentinel extends PyricSentinel {
  const PyricServerTimestampSentinel();

  @override
  Map<String, dynamic> toWireSentinel() => const {'__sentinel': 'serverTimestamp'};

  @override
  bool operator ==(Object other) => other is PyricServerTimestampSentinel;

  @override
  int get hashCode => 'serverTimestamp'.hashCode;

  @override
  String toString() => 'PyricServerTimestampSentinel()';
}

/// Sentinel that atomically increments a numeric field by [n].
class PyricIncrementSentinel extends PyricSentinel {
  final num n;

  const PyricIncrementSentinel(this.n);

  @override
  Map<String, dynamic> toWireSentinel() => {'__sentinel': 'increment', 'n': n};

  @override
  bool operator ==(Object other) => other is PyricIncrementSentinel && other.n == n;

  @override
  int get hashCode => Object.hash('increment', n);

  @override
  String toString() => 'PyricIncrementSentinel($n)';
}

/// Sentinel that atomically adds [values] to an array if absent.
class PyricArrayUnionSentinel extends PyricSentinel {
  final List<dynamic> values;

  const PyricArrayUnionSentinel(this.values);

  @override
  Map<String, dynamic> toWireSentinel() => {
        '__sentinel': 'arrayUnion',
        'values': values.map(encodeValue).toList(),
      };

  @override
  bool operator ==(Object other) =>
      other is PyricArrayUnionSentinel && _listEquals(other.values, values);

  @override
  int get hashCode => Object.hash('arrayUnion', Object.hashAll(values));

  @override
  String toString() => 'PyricArrayUnionSentinel($values)';
}

/// Sentinel that atomically removes [values] from an array field.
class PyricArrayRemoveSentinel extends PyricSentinel {
  final List<dynamic> values;

  const PyricArrayRemoveSentinel(this.values);

  @override
  Map<String, dynamic> toWireSentinel() => {
        '__sentinel': 'arrayRemove',
        'values': values.map(encodeValue).toList(),
      };

  @override
  bool operator ==(Object other) =>
      other is PyricArrayRemoveSentinel && _listEquals(other.values, values);

  @override
  int get hashCode => Object.hash('arrayRemove', Object.hashAll(values));

  @override
  String toString() => 'PyricArrayRemoveSentinel($values)';
}

/// Sentinel that deletes the target field during document update.
class PyricDeleteFieldSentinel extends PyricSentinel {
  const PyricDeleteFieldSentinel();

  @override
  Map<String, dynamic> toWireSentinel() => const {'__sentinel': 'deleteField'};

  @override
  bool operator ==(Object other) => other is PyricDeleteFieldSentinel;

  @override
  int get hashCode => 'deleteField'.hashCode;

  @override
  String toString() => 'PyricDeleteFieldSentinel()';
}

/// Convenience factory namespace for sentinels.
class PyricSentinels {
  static const PyricServerTimestampSentinel serverTimestamp =
      PyricServerTimestampSentinel();
  static const PyricDeleteFieldSentinel deleteField =
      PyricDeleteFieldSentinel();

  static PyricIncrementSentinel increment(num n) => PyricIncrementSentinel(n);

  static PyricArrayUnionSentinel arrayUnion(List<dynamic> values) =>
      PyricArrayUnionSentinel(values);

  static PyricArrayRemoveSentinel arrayRemove(List<dynamic> values) =>
      PyricArrayRemoveSentinel(values);
}

bool _listEquals(List<dynamic> a, List<dynamic> b) {
  if (identical(a, b)) return true;
  if (a.length != b.length) return false;
  for (int i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}
