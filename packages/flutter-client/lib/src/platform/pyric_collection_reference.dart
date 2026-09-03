import 'dart:math';

import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import 'pyric_document_reference.dart';
import 'pyric_query.dart';

/// Concrete [CollectionReferencePlatform] referencing a collection in Pyric Firestore.
class PyricCollectionReference extends PyricQuery
    implements CollectionReferencePlatform {
  static const String _autoIdAlphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  static final Random _random = Random();

  PyricCollectionReference(
    super.firestore,
    super.path,
  );

  /// Generates a standard 20-character random Firestore document ID.
  static String autoId() {
    final buffer = StringBuffer();
    for (int i = 0; i < 20; i++) {
      buffer.write(_autoIdAlphabet[_random.nextInt(_autoIdAlphabet.length)]);
    }
    return buffer.toString();
  }

  @override
  String get id => path.split('/').last;

  @override
  DocumentReferencePlatform? get parent {
    final lastSlash = path.lastIndexOf('/');
    if (lastSlash == -1) return null;
    return firestore.doc(path.substring(0, lastSlash));
  }

  @override
  DocumentReferencePlatform doc([String? path]) {
    final targetPath = (path != null && path.isNotEmpty)
        ? '${this.path}/$path'
        : '${this.path}/${autoId()}';
    return PyricDocumentReference(firestore, targetPath);
  }

  /// Writes [data] to a newly created document with an auto-generated ID.
  Future<DocumentReferencePlatform> add(Map<String, dynamic> data) async {
    final docRef = doc();
    await docRef.set(data);
    return docRef;
  }

  @override
  bool operator ==(Object other) =>
      other is CollectionReferencePlatform &&
      other.firestore == firestore &&
      other.path == path;

  @override
  int get hashCode => Object.hash(firestore, path);
}
