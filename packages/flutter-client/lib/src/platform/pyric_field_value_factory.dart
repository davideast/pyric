import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import '../transport/codecs.dart';

/// Concrete [FieldValuePlatform] wrapping a [PyricSentinel].
class PyricFieldValue extends FieldValuePlatform {
  final PyricSentinel sentinel;

  PyricFieldValue(this.sentinel) : super(sentinel);

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PyricFieldValue && other.sentinel == sentinel;

  @override
  int get hashCode => sentinel.hashCode;

  @override
  String toString() => 'PyricFieldValue($sentinel)';
}

/// Recursively unwraps any [FieldValuePlatform] wrappers down to raw delegates/sentinels.
dynamic unwrapFieldValues(dynamic value) {
  if (value is FieldValuePlatform) {
    final delegate = FieldValuePlatform.getDelegate(value);
    return unwrapFieldValues(delegate);
  }
  if (value is Map) {
    return value.map((k, v) => MapEntry(k.toString(), unwrapFieldValues(v)));
  }
  if (value is List) {
    return value.map(unwrapFieldValues).toList();
  }
  return value;
}

/// Concrete [FieldValueFactoryPlatform] producing Pyric sentinel values.
class PyricFieldValueFactory extends FieldValueFactoryPlatform {
  @override
  FieldValuePlatform serverTimestamp() {
    return PyricFieldValue(const PyricServerTimestampSentinel());
  }

  @override
  FieldValuePlatform delete() {
    return PyricFieldValue(const PyricDeleteFieldSentinel());
  }

  @override
  FieldValuePlatform increment(num value) {
    return PyricFieldValue(PyricIncrementSentinel(value));
  }

  @override
  FieldValuePlatform arrayUnion(List<dynamic> elements) {
    return PyricFieldValue(PyricArrayUnionSentinel(elements));
  }

  @override
  FieldValuePlatform arrayRemove(List<dynamic> elements) {
    return PyricFieldValue(PyricArrayRemoveSentinel(elements));
  }
}
