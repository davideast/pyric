import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import '../transport/codecs.dart';
import 'pyric_field_value_factory.dart';

/// Serializes document data for set operations into unwrapped bridge wire values.
Map<String, dynamic> serializeSetData(Map<String, dynamic> data) {
  return unwrapFieldValues(data) as Map<String, dynamic>;
}

bool _needsFieldPathQuoting(String segment) {
  return segment.isEmpty ||
      segment.contains('.') ||
      segment.contains('`') ||
      segment.contains(r'\');
}

/// Encodes a [FieldPath] segment vector as a canonical update/merge mask key,
/// backtick-quoting segments that contain `.`, `` ` ``, or `\` so the host
/// `fieldPathKeySegments` decoder preserves literal dots.
String encodeFieldPathKey(List<String> segments) {
  return segments.map((segment) {
    if (!_needsFieldPathQuoting(segment)) return segment;
    final escaped = segment.replaceAll(r'\', r'\\').replaceAll('`', r'\`');
    return '`$escaped`';
  }).join('.');
}

/// Decodes an encoded field-path key back into its literal segments.
List<String> decodeFieldPathKeySegments(String key) {
  if (!key.contains('`')) return key.split('.');
  final segments = <String>[];
  final current = StringBuffer();
  var quoted = false;
  for (var i = 0; i < key.length; i++) {
    final char = key[i];
    if (quoted) {
      if (char == r'\' && i + 1 < key.length) {
        current.write(key[++i]);
      } else if (char == '`') {
        quoted = false;
      } else {
        current.write(char);
      }
      continue;
    }
    if (char == '`') {
      quoted = true;
    } else if (char == '.') {
      segments.add(current.toString());
      current.clear();
    } else {
      current.write(char);
    }
  }
  segments.add(current.toString());
  return segments;
}

/// Serializes [SetOptions] into canonical bridge wire format.
Map<String, dynamic>? serializeSetOptions(SetOptions? options) {
  if (options == null) return null;
  return <String, dynamic>{
    if (options.merge != null) 'merge': options.merge,
    if (options.mergeFields != null)
      'mergeFields': options.mergeFields!
          .map((fp) => encodeFieldPathKey(fp.components))
          .toList(),
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
