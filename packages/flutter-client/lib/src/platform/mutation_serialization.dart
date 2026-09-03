import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
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

/// Serializes [FieldPath] dictionary into dotted string keys with unwrapped values.
Map<String, dynamic> serializeUpdateData(Map<FieldPath, dynamic> data) {
  final stringMap = <String, dynamic>{};
  data.forEach((fieldPath, val) {
    stringMap[fieldPath.components.join('.')] = unwrapFieldValues(val);
  });
  return stringMap;
}
