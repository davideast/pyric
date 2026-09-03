import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import 'pyric_document_snapshot.dart';

/// Concrete [QuerySnapshotPlatform] representing query results in Pyric Firestore.
class PyricQuerySnapshot extends QuerySnapshotPlatform {
  final FirebaseFirestorePlatform firestore;

  PyricQuerySnapshot(
    this.firestore,
    List<DocumentSnapshotPlatform> docs, {
    List<DocumentChangePlatform>? docChanges,
    SnapshotMetadataPlatform? metadata,
  }) : super(
          docs,
          docChanges ?? buildDefaultDocChanges(docs),
          metadata ?? SnapshotMetadataPlatform(false, false),
        );

  static List<DocumentChangePlatform> buildDefaultDocChanges(
    List<DocumentSnapshotPlatform> docs,
  ) {
    return List.generate(
      docs.length,
      (i) => DocumentChangePlatform(
        DocumentChangeType.added,
        -1,
        i,
        docs[i],
      ),
    );
  }

  /// Deserializes a query snapshot from bridge JSON results (`{ "docs": [...] }`).
  factory PyricQuerySnapshot.fromWire(
    FirebaseFirestorePlatform firestore,
    String defaultPath,
    dynamic wire, {
    List<DocumentSnapshotPlatform>? previousDocs,
    bool hasPendingWrites = false,
    bool isFromCache = false,
  }) {
    final docsList = <DocumentSnapshotPlatform>[];
    if (wire is Map && wire['docs'] is List) {
      for (final item in wire['docs'] as List) {
        docsList.add(
          PyricDocumentSnapshot.fromWire(
            firestore,
            defaultPath,
            item,
            hasPendingWrites: hasPendingWrites,
            isFromCache: isFromCache,
          ),
        );
      }
    } else if (wire is List) {
      for (final item in wire) {
        docsList.add(
          PyricDocumentSnapshot.fromWire(
            firestore,
            defaultPath,
            item,
            hasPendingWrites: hasPendingWrites,
            isFromCache: isFromCache,
          ),
        );
      }
    }

    final docChanges = computeDocChanges(previousDocs ?? const [], docsList);
    return PyricQuerySnapshot(
      firestore,
      docsList,
      docChanges: docChanges,
      metadata: SnapshotMetadataPlatform(hasPendingWrites, isFromCache),
    );
  }

  /// Computes document changes between previous snapshot and current snapshot.
  static List<DocumentChangePlatform> computeDocChanges(
    List<DocumentSnapshotPlatform> oldDocs,
    List<DocumentSnapshotPlatform> newDocs,
  ) {
    if (oldDocs.isEmpty) {
      return buildDefaultDocChanges(newDocs);
    }

    final changes = <DocumentChangePlatform>[];
    final oldMap = <String, (int, DocumentSnapshotPlatform)>{};
    for (int i = 0; i < oldDocs.length; i++) {
      oldMap[oldDocs[i].id] = (i, oldDocs[i]);
    }

    final newMap = <String, (int, DocumentSnapshotPlatform)>{};
    for (int i = 0; i < newDocs.length; i++) {
      newMap[newDocs[i].id] = (i, newDocs[i]);
    }

    // Removed documents
    oldMap.forEach((id, pair) {
      if (!newMap.containsKey(id)) {
        changes.add(
          DocumentChangePlatform(
            DocumentChangeType.removed,
            pair.$1,
            -1,
            pair.$2,
          ),
        );
      }
    });

    // Added or modified documents
    newMap.forEach((id, pair) {
      final newIndex = pair.$1;
      final newDoc = pair.$2;
      if (!oldMap.containsKey(id)) {
        changes.add(
          DocumentChangePlatform(
            DocumentChangeType.added,
            -1,
            newIndex,
            newDoc,
          ),
        );
      } else {
        final oldIndex = oldMap[id]!.$1;
        final oldDoc = oldMap[id]!.$2;
        if (!_mapsEqual(oldDoc.data(), newDoc.data())) {
          changes.add(
            DocumentChangePlatform(
              DocumentChangeType.modified,
              oldIndex,
              newIndex,
              newDoc,
            ),
          );
        }
      }
    });

    return changes;
  }

  static bool _mapsEqual(Map<String, dynamic>? a, Map<String, dynamic>? b) {
    return _deepEquals(a, b);
  }

  static bool _deepEquals(dynamic a, dynamic b) {
    if (identical(a, b)) return true;
    if (a is Map && b is Map) {
      if (a.length != b.length) return false;
      for (final key in a.keys) {
        if (!b.containsKey(key) || !_deepEquals(a[key], b[key])) return false;
      }
      return true;
    }
    if (a is List && b is List) {
      if (a.length != b.length) return false;
      for (var i = 0; i < a.length; i++) {
        if (!_deepEquals(a[i], b[i])) return false;
      }
      return true;
    }
    return a == b;
  }
}
