import 'dart:math';

import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import 'pyric_document_reference.dart';
import 'pyric_query.dart';

/// Concrete [CollectionReferencePlatform] referencing a collection in Pyric Firestore.
class PyricCollectionReference extends CollectionReferencePlatform {
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

  PyricQuery _asQuery() => PyricQuery(firestore, path);

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
  QueryPlatform where(Iterable<List<dynamic>> conditions) =>
      _asQuery().where(conditions);

  @override
  QueryPlatform whereFilter(FilterPlatformInterface filter) =>
      _asQuery().whereFilter(filter);

  @override
  QueryPlatform orderBy(Iterable<List<dynamic>> orders) =>
      _asQuery().orderBy(orders);

  @override
  QueryPlatform limit(int limit) => _asQuery().limit(limit);

  @override
  QueryPlatform limitToLast(int limit) => _asQuery().limitToLast(limit);

  @override
  QueryPlatform startAt(Iterable<dynamic> fields) => _asQuery().startAt(fields);

  @override
  QueryPlatform startAfter(Iterable<dynamic> fields) =>
      _asQuery().startAfter(fields);

  @override
  QueryPlatform endAt(Iterable<dynamic> fields) => _asQuery().endAt(fields);

  @override
  QueryPlatform endBefore(Iterable<dynamic> fields) =>
      _asQuery().endBefore(fields);

  @override
  QueryPlatform startAtDocument(
          Iterable<dynamic> orders, Iterable<dynamic> values) =>
      _asQuery().startAtDocument(orders, values);

  @override
  QueryPlatform startAfterDocument(
          Iterable<dynamic> orders, Iterable<dynamic> values) =>
      _asQuery().startAfterDocument(orders, values);

  @override
  QueryPlatform endAtDocument(
          Iterable<dynamic> orders, Iterable<dynamic> values) =>
      _asQuery().endAtDocument(orders, values);

  @override
  QueryPlatform endBeforeDocument(
          Iterable<dynamic> orders, Iterable<dynamic> values) =>
      _asQuery().endBeforeDocument(orders, values);

  @override
  AggregateQueryPlatform count() => _asQuery().count();

  @override
  AggregateQueryPlatform aggregate(
    AggregateField aggregateField1, [
    AggregateField? aggregateField2,
    AggregateField? aggregateField3,
    AggregateField? aggregateField4,
    AggregateField? aggregateField5,
    AggregateField? aggregateField6,
    AggregateField? aggregateField7,
    AggregateField? aggregateField8,
    AggregateField? aggregateField9,
    AggregateField? aggregateField10,
    AggregateField? aggregateField11,
    AggregateField? aggregateField12,
    AggregateField? aggregateField13,
    AggregateField? aggregateField14,
    AggregateField? aggregateField15,
    AggregateField? aggregateField16,
    AggregateField? aggregateField17,
    AggregateField? aggregateField18,
    AggregateField? aggregateField19,
    AggregateField? aggregateField20,
    AggregateField? aggregateField21,
    AggregateField? aggregateField22,
    AggregateField? aggregateField23,
    AggregateField? aggregateField24,
    AggregateField? aggregateField25,
    AggregateField? aggregateField26,
    AggregateField? aggregateField27,
    AggregateField? aggregateField28,
    AggregateField? aggregateField29,
    AggregateField? aggregateField30,
  ]) =>
      _asQuery().aggregate(
        aggregateField1,
        aggregateField2,
        aggregateField3,
        aggregateField4,
        aggregateField5,
        aggregateField6,
        aggregateField7,
        aggregateField8,
        aggregateField9,
        aggregateField10,
        aggregateField11,
        aggregateField12,
        aggregateField13,
        aggregateField14,
        aggregateField15,
        aggregateField16,
        aggregateField17,
        aggregateField18,
        aggregateField19,
        aggregateField20,
        aggregateField21,
        aggregateField22,
        aggregateField23,
        aggregateField24,
        aggregateField25,
        aggregateField26,
        aggregateField27,
        aggregateField28,
        aggregateField29,
        aggregateField30,
      );

  @override
  AggregateQueryPlatform sum(String field) => _asQuery().sum(field);

  @override
  AggregateQueryPlatform average(String field) => _asQuery().average(field);

  @override
  Future<QuerySnapshotPlatform> get([GetOptions options = const GetOptions()]) =>
      _asQuery().get(options);

  @override
  Stream<QuerySnapshotPlatform> snapshots({
    bool includeMetadataChanges = false,
    ListenSource listenSource = ListenSource.defaultSource,
  }) =>
      _asQuery().snapshots(
        includeMetadataChanges: includeMetadataChanges,
        listenSource: listenSource,
      );
}
