import 'query_compiler.dart';

// ─── Target Descriptors ─────────────────────────────────────────────────────

/// Base class for all Firestore target descriptors on the Pyric bridge.
abstract class TargetDescriptor {
  const TargetDescriptor();

  /// Converts descriptor into canonical wire JSON format.
  Map<String, dynamic> toMap();
}

/// Target descriptor pointing to a specific document path.
class DocumentTargetDescriptor extends TargetDescriptor {
  final String path;

  const DocumentTargetDescriptor(this.path);

  @override
  Map<String, dynamic> toMap() => {
        '__ref': 'doc',
        'path': path,
      };

  @override
  String toString() => 'DocumentTargetDescriptor($path)';
}

/// Target descriptor pointing to a collection path.
class CollectionTargetDescriptor extends TargetDescriptor {
  final String path;

  const CollectionTargetDescriptor(this.path);

  @override
  Map<String, dynamic> toMap() => {
        '__ref': 'collection',
        'path': path,
      };

  @override
  String toString() => 'CollectionTargetDescriptor($path)';
}

/// Target descriptor pointing to a collection group ID.
class CollectionGroupTargetDescriptor extends TargetDescriptor {
  final String collectionId;

  const CollectionGroupTargetDescriptor(this.collectionId);

  @override
  Map<String, dynamic> toMap() => {
        '__ref': 'group',
        'collectionId': collectionId,
      };

  @override
  String toString() => 'CollectionGroupTargetDescriptor($collectionId)';
}

/// Target descriptor representing a filtered and ordered query.
class QueryTargetDescriptor extends TargetDescriptor {
  final TargetDescriptor source;
  final List<QueryConstraint> constraints;

  const QueryTargetDescriptor({
    required this.source,
    this.constraints = const [],
  });

  @override
  Map<String, dynamic> toMap() {
    final compiledConstraints = constraints.map((c) => c.toMap()).toList();
    return QueryCompiler.compileTargetDescriptor(
      source: source.toMap(),
      constraints: compiledConstraints,
    );
  }

  @override
  String toString() =>
      'QueryTargetDescriptor(source: $source, constraints: $constraints)';
}
