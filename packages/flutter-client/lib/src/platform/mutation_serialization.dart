import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import '../transport/codecs.dart';
import 'pyric_field_value_factory.dart';

/// Serializes document data for set operations into unwrapped bridge wire values.
Map<String, dynamic> serializeSetData(Map<String, dynamic> data) {
  return unwrapFieldValues(data) as Map<String, dynamic>;
}

/// Serializes [SetOptions] into canonical bridge wire format.
Map<String, dynamic>? serializeSetOptions(SetOptions? options) {
  if (options == null) return null;
  return <String, dynamic>{
    if (options.merge != null) 'merge': options.merge,
    if (options.mergeFields != null)
      'mergeFields':
          options.mergeFields!.map((fp) => fp.components.join('.')).toList(),
  };
}

/// Returns true when any [FieldPath] segment contains a literal `.` character.
bool hasLiteralDotSegment(Iterable<FieldPath> paths) {
  for (final fp in paths) {
    for (final segment in fp.components) {
      if (segment.contains('.')) return true;
    }
  }
  return false;
}

/// Serializes [FieldPath] dictionary into dotted string keys with unwrapped values.
Map<String, dynamic> serializeUpdateData(Map<FieldPath, dynamic> data) {
  final stringMap = <String, dynamic>{};
  data.forEach((fieldPath, val) {
    stringMap[fieldPath.components.join('.')] = unwrapFieldValues(val);
  });
  return stringMap;
}

/// Serializes [FieldPath] entries as explicit segment vectors (`[{ path, value }]`)
/// so field names containing literal `.` characters are never split on the wire.
List<Map<String, dynamic>> serializeUpdateFieldDescriptors(
  Map<FieldPath, dynamic> data,
) {
  final out = <Map<String, dynamic>>[];
  data.forEach((fieldPath, val) {
    out.add({
      'path': List<String>.from(fieldPath.components),
      'value': encodeValue(unwrapFieldValues(val)),
    });
  });
  return out;
}

/// Serializes [FieldPath] entries for local offline projection with preserved segments.
List<MapEntry<List<String>, dynamic>> serializeOfflineUpdateSegments(
  Map<FieldPath, dynamic> data,
) {
  final out = <MapEntry<List<String>, dynamic>>[];
  data.forEach((fieldPath, val) {
    out.add(
      MapEntry(
        List<String>.from(fieldPath.components),
        encodeValue(unwrapFieldValues(val)),
      ),
    );
  });
  return out;
}
