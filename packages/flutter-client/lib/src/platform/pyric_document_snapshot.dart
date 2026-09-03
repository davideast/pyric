import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import '../transport/codecs.dart';

/// Concrete [DocumentSnapshotPlatform] representing a document in Pyric Firestore.
class PyricDocumentSnapshot extends DocumentSnapshotPlatform {
  PyricDocumentSnapshot(
    FirebaseFirestorePlatform firestore,
    String path,
    Map<String?, Object?>? data, {
    bool hasPendingWrites = false,
    bool isFromCache = false,
  }) : super(
          firestore,
          path,
          data,
          InternalSnapshotMetadata(
            hasPendingWrites: hasPendingWrites,
            isFromCache: isFromCache,
          ),
        );

  /// Deserializes a document snapshot received from Pyric bridge transport.
  factory PyricDocumentSnapshot.fromWire(
    FirebaseFirestorePlatform firestore,
    String defaultPath,
    dynamic wire, {
    bool hasPendingWrites = false,
    bool isFromCache = false,
  }) {
    if (wire == null) {
      return PyricDocumentSnapshot(
        firestore,
        defaultPath,
        null,
        hasPendingWrites: hasPendingWrites,
        isFromCache: isFromCache,
      );
    }

    if (wire is! Map) {
      return PyricDocumentSnapshot(
        firestore,
        defaultPath,
        null,
        hasPendingWrites: hasPendingWrites,
        isFromCache: isFromCache,
      );
    }

    final path = (wire['path'] as String?) ?? defaultPath;
    final exists = wire['exists'] == true;

    if (!exists && wire.containsKey('exists')) {
      return PyricDocumentSnapshot(
        firestore,
        path,
        null,
        hasPendingWrites: hasPendingWrites,
        isFromCache: isFromCache,
      );
    }

    // Envelope data could be in wire['data'] ({ json: "..." }) or raw in wire
    final rawData = wire.containsKey('data') ? wire['data'] : wire;
    if (rawData == null) {
      return PyricDocumentSnapshot(
        firestore,
        path,
        null,
        hasPendingWrites: hasPendingWrites,
        isFromCache: isFromCache,
      );
    }

    final decoded = decodeDocData(
      rawData,
      referenceResolver: (refPath) => firestore.doc(refPath),
    );

    return PyricDocumentSnapshot(
      firestore,
      path,
      decoded.cast<String?, Object?>(),
      hasPendingWrites: hasPendingWrites,
      isFromCache: isFromCache,
    );
  }
}
