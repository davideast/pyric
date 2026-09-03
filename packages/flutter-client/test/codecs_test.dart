import 'dart:convert';
import 'dart:typed_data';

import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/src/transport/codecs.dart';
import 'package:pyric_firestore/src/transport/query_compiler.dart';

void main() {
  group('Pyric Value Codecs: Primitives', () {
    test('serializes and deserializes null, boolean, and numeric primitives', () {
      expect(encodeValue(null), isNull);
      expect(decodeValue(null), isNull);

      expect(encodeValue(true), isTrue);
      expect(decodeValue(true), isTrue);

      expect(encodeValue(false), isFalse);
      expect(decodeValue(false), isFalse);

      expect(encodeValue(42), equals(42));
      expect(decodeValue(42), equals(42));

      expect(encodeValue(3.14159), equals(3.14159));
      expect(decodeValue(3.14159), equals(3.14159));

      expect(encodeValue('hello world'), equals('hello world'));
      expect(decodeValue('hello world'), equals('hello world'));
    });

    test('serializes and deserializes nested lists and maps', () {
      final input = {
        'string': 'value',
        'number': 123,
        'nested': {
          'innerList': [1, 2, 'three', true, null],
          'innerMap': {'a': 1, 'b': false},
        },
        'list': [
          {'key': 'item1'},
          {'key': 'item2'},
        ],
      };

      final encoded = encodeValue(input);
      expect(encoded, equals(input));

      final decoded = decodeValue(encoded);
      expect(decoded, equals(input));
    });
  });

  group('Pyric Value Codecs: Firestore Typed Objects', () {
    test('serializes and deserializes Timestamp (primary __type marker)', () {
      final ts = Timestamp(1712000000, 543210);
      final encoded = encodeValue(ts);
      expect(
        encoded,
        equals({'__type': 'timestamp', 'seconds': 1712000000, 'nanos': 543210}),
      );

      final decoded = decodeValue(encoded);
      expect(decoded, isA<Timestamp>());
      final decodedTs = decoded as Timestamp;
      expect(decodedTs.seconds, equals(1712000000));
      expect(decodedTs.nanoseconds, equals(543210));
    });

    test('serializes DateTime into Timestamp marker shape', () {
      final dt = DateTime.utc(2026, 4, 1, 12, 0, 0, 123);
      final encoded = encodeValue(dt) as Map<String, dynamic>;
      expect(encoded['__type'], equals('timestamp'));
      expect(encoded['seconds'], equals(dt.millisecondsSinceEpoch ~/ 1000));
      expect(encoded['nanos'], equals(123000000));

      final decoded = decodeValue(encoded) as Timestamp;
      expect(decoded.millisecondsSinceEpoch, equals(dt.millisecondsSinceEpoch));
    });

    test('serializes pre-1970 DateTime without truncation sign-flip', () {
      final pre1970 = DateTime.utc(1969, 12, 31, 23, 59, 59, 500); // -500 ms
      final encoded = encodeValue(pre1970) as Map<String, dynamic>;
      expect(encoded['__type'], equals('timestamp'));
      expect(encoded['seconds'], equals(-1));
      expect(encoded['nanos'], equals(500000000));

      final decoded = decodeValue(encoded) as Timestamp;
      expect(decoded.seconds, equals(-1));
      expect(decoded.nanoseconds, equals(500000000));
      expect(decoded.millisecondsSinceEpoch, equals(-500));

      final deepPast = DateTime.utc(1960, 1, 1, 0, 0, 0, 0);
      final encodedDeep = encodeValue(deepPast) as Map<String, dynamic>;
      final decodedDeep = decodeValue(encodedDeep) as Timestamp;
      expect(decodedDeep.toDate().toUtc(), equals(deepPast));
      expect(decodedDeep.millisecondsSinceEpoch, equals(deepPast.millisecondsSinceEpoch));
    });

    test('deserializes compatibility Timestamp marker (type: firestore/timestamp/1.0)', () {
      final wire = {
        'type': 'firestore/timestamp/1.0',
        'seconds': 1600000000,
        'nanoseconds': 999,
      };

      final decoded = decodeValue(wire) as Timestamp;
      expect(decoded.seconds, equals(1600000000));
      expect(decoded.nanoseconds, equals(999));
    });

    test('serializes and deserializes GeoPoint (primary __type marker)', () {
      const geo = GeoPoint(37.7749, -122.4194);
      final encoded = encodeValue(geo);
      expect(
        encoded,
        equals({'__type': 'latlng', 'lat': 37.7749, 'lng': -122.4194}),
      );

      final decoded = decodeValue(encoded) as GeoPoint;
      expect(decoded.latitude, equals(37.7749));
      expect(decoded.longitude, equals(-122.4194));
    });

    test('deserializes compatibility GeoPoint marker (type: firestore/geoPoint/1.0)', () {
      final wire = {
        'type': 'firestore/geoPoint/1.0',
        'latitude': -33.8688,
        'longitude': 151.2093,
      };

      final decoded = decodeValue(wire) as GeoPoint;
      expect(decoded.latitude, equals(-33.8688));
      expect(decoded.longitude, equals(151.2093));
    });

    test('serializes and deserializes Blob and Uint8List (RFC 4648 base64url unpadded)', () {
      final bytes = Uint8List.fromList([0, 1, 2, 250, 255, 10, 20]);
      final blob = Blob(bytes);

      final encodedBlob = encodeValue(blob) as Map<String, dynamic>;
      expect(encodedBlob['__type'], equals('bytes'));
      expect(encodedBlob['base64'], isA<String>());
      expect((encodedBlob['base64'] as String).contains('='), isFalse);

      final encodedRawBytes = encodeValue(bytes) as Map<String, dynamic>;
      expect(encodedRawBytes, equals(encodedBlob));

      final decoded = decodeValue(encodedBlob) as Blob;
      expect(decoded.bytes, equals(bytes));
    });

    test('deserializes compatibility Bytes marker (type: firestore/bytes/1.0, standard base64)', () {
      final original = Uint8List.fromList([10, 20, 30, 40, 50]);
      final wire = {
        'type': 'firestore/bytes/1.0',
        'bytes': base64.encode(original),
      };

      final decoded = decodeValue(wire) as Blob;
      expect(decoded.bytes, equals(original));
    });

    test('serializes and deserializes DocumentReference', () {
      const refHolder = PyricDocumentReferenceHolder('users/alovelace');
      final encoded = encodeValue(refHolder);
      expect(
        encoded,
        equals({'__type': 'reference', 'path': 'users/alovelace'}),
      );

      final decoded = decodeValue(encoded) as PyricDocumentReferenceHolder;
      expect(decoded.path, equals('users/alovelace'));

      // Test with custom reference resolver
      final resolved = decodeValue(
        encoded,
        referenceResolver: (path) => 'ResolvedReference($path)',
      );
      expect(resolved, equals('ResolvedReference(users/alovelace)'));
    });
  });

  group('Pyric Value Codecs: FieldValue Sentinels', () {
    test('serverTimestamp sentinel', () {
      const sentinel = PyricSentinels.serverTimestamp;
      final encoded = encodeValue(sentinel);
      expect(encoded, equals({'__sentinel': 'serverTimestamp'}));

      // Transmutation from __type shape
      expect(
        encodeValue({'__type': 'serverTimestamp'}),
        equals({'__sentinel': 'serverTimestamp'}),
      );
    });

    test('increment sentinel', () {
      final sentinel = PyricSentinels.increment(42);
      final encoded = encodeValue(sentinel);
      expect(encoded, equals({'__sentinel': 'increment', 'n': 42}));

      // Floating-point increment
      expect(
        encodeValue(PyricSentinels.increment(-3.5)),
        equals({'__sentinel': 'increment', 'n': -3.5}),
      );

      // Transmutation from __type shape
      expect(
        encodeValue({'__type': 'increment', 'value': 10}),
        equals({'__sentinel': 'increment', 'n': 10}),
      );
    });

    test('arrayUnion sentinel', () {
      final ts = Timestamp(1700000000, 0);
      final sentinel = PyricSentinels.arrayUnion(['item1', ts, 99]);
      final encoded = encodeValue(sentinel);
      expect(
        encoded,
        equals({
          '__sentinel': 'arrayUnion',
          'values': [
            'item1',
            {'__type': 'timestamp', 'seconds': 1700000000, 'nanos': 0},
            99,
          ],
        }),
      );

      // Transmutation from __type shape
      expect(
        encodeValue({'__type': 'arrayUnion', 'values': ['x', 'y']}),
        equals({
          '__sentinel': 'arrayUnion',
          'values': ['x', 'y'],
        }),
      );
    });

    test('arrayRemove sentinel', () {
      final sentinel = PyricSentinels.arrayRemove(['oldItem', 123]);
      final encoded = encodeValue(sentinel);
      expect(
        encoded,
        equals({
          '__sentinel': 'arrayRemove',
          'values': ['oldItem', 123],
        }),
      );

      // Transmutation from __type shape
      expect(
        encodeValue({'__type': 'arrayRemove', 'values': ['z']}),
        equals({
          '__sentinel': 'arrayRemove',
          'values': ['z'],
        }),
      );
    });

    test('deleteField sentinel', () {
      const sentinel = PyricSentinels.deleteField;
      final encoded = encodeValue(sentinel);
      expect(encoded, equals({'__sentinel': 'deleteField'}));

      // Transmutation from __type shape
      expect(
        encodeValue({'__type': 'deleteField'}),
        equals({'__sentinel': 'deleteField'}),
      );
      expect(
        encodeValue({'__type': 'delete'}),
        equals({'__sentinel': 'deleteField'}),
      );
    });
  });

  group('Pyric Value Codecs: Snapshot Envelope Reviver', () {
    test('decodes full document envelope with nested typed markers', () {
      final envelope = {
        'json': jsonEncode({
          'name': 'Ada Lovelace',
          'age': 36,
          'active': true,
          'createdAt': {
            '__type': 'timestamp',
            'seconds': 1712000000,
            'nanos': 250000,
          },
          'location': {
            '__type': 'latlng',
            'lat': 51.5074,
            'lng': -0.1278,
          },
          'avatar': {
            '__type': 'bytes',
            'base64': base64UrlEncodeUnpadded(Uint8List.fromList([1, 2, 3, 4])),
          },
          'mentor': {
            '__type': 'reference',
            'path': 'users/charles_babbage',
          },
          'stats': {
            'scores': [100, 95, 88],
            'lastLogin': {
              'type': 'firestore/timestamp/1.0',
              'seconds': 1712100000,
              'nanoseconds': 0,
            },
          },
        }),
      };

      final data = decodeDocData(envelope);

      expect(data['name'], equals('Ada Lovelace'));
      expect(data['age'], equals(36));
      expect(data['active'], isTrue);

      expect(data['createdAt'], isA<Timestamp>());
      final createdAt = data['createdAt'] as Timestamp;
      expect(createdAt.seconds, equals(1712000000));
      expect(createdAt.nanoseconds, equals(250000));

      expect(data['location'], isA<GeoPoint>());
      final location = data['location'] as GeoPoint;
      expect(location.latitude, equals(51.5074));
      expect(location.longitude, equals(-0.1278));

      expect(data['avatar'], isA<Blob>());
      final avatar = data['avatar'] as Blob;
      expect(avatar.bytes, equals(Uint8List.fromList([1, 2, 3, 4])));

      expect(data['mentor'], isA<PyricDocumentReferenceHolder>());
      final mentor = data['mentor'] as PyricDocumentReferenceHolder;
      expect(mentor.path, equals('users/charles_babbage'));

      final stats = data['stats'] as Map<String, dynamic>;
      expect(stats['scores'], equals([100, 95, 88]));
      expect(stats['lastLogin'], isA<Timestamp>());
    });

    test('handles empty or missing JSON envelope gracefully', () {
      expect(decodeDocData(null), equals(<String, dynamic>{}));
      expect(decodeDocData({}), equals(<String, dynamic>{}));
      expect(decodeDocData('invalid json'), equals(<String, dynamic>{}));
      expect(decodeDocData({'json': '{}'}), equals(<String, dynamic>{}));
    });

    test('handles malformed JSON envelopes gracefully without throwing FormatException', () {
      expect(decodeDocData({'json': '{invalid_json}'}), equals(<String, dynamic>{}));
      expect(decodeDocData({'json': '{"unclosed": '}), equals(<String, dynamic>{}));
      expect(decodeDocData({'json': 'not even json'}), equals(<String, dynamic>{}));
      expect(decodeDocData({'json': ''}), equals(<String, dynamic>{}));
    });
  });

  group('Query Compiler: Target Descriptors & Constraints', () {
    test('compiles document, collection, and group target descriptors', () {
      expect(
        QueryCompiler.compileDocumentTarget('users/alice'),
        equals({'__ref': 'doc', 'path': 'users/alice'}),
      );

      expect(
        QueryCompiler.compileCollectionTarget('users'),
        equals({'__ref': 'collection', 'path': 'users'}),
      );

      expect(
        QueryCompiler.compileGroupTarget('comments'),
        equals({'__ref': 'group', 'collectionId': 'comments'}),
      );
    });

    test('compiles query with where, orderBy, limit, and cursor constraints', () {
      final ts = Timestamp(1712000000, 0);
      final collection = QueryCompiler.compileCollectionTarget('scores');

      final constraints = [
        QueryCompiler.compileWhere('team', '==', 'red'),
        QueryCompiler.compileWhere('timestamp', '>=', ts),
        QueryCompiler.compileOrderBy('points', direction: 'desc'),
        QueryCompiler.compileLimit(10),
        QueryCompiler.compileCursor('startAfter', [100, ts]),
      ];

      final target = QueryCompiler.compileTargetDescriptor(
        source: collection,
        constraints: constraints,
      );

      expect(
        target,
        equals({
          '__ref': 'query',
          'source': {'__ref': 'collection', 'path': 'scores'},
          'constraints': [
            {'kind': 'where', 'field': 'team', 'op': '==', 'value': 'red'},
            {
              'kind': 'where',
              'field': 'timestamp',
              'op': '>=',
              'value': {
                '__type': 'timestamp',
                'seconds': 1712000000,
                'nanos': 0,
              },
            },
            {'kind': 'orderBy', 'field': 'points', 'direction': 'desc'},
            {'kind': 'limit', 'n': 10},
            {
              'kind': 'startAfter',
              'values': [
                100,
                {'__type': 'timestamp', 'seconds': 1712000000, 'nanos': 0},
              ],
            },
          ],
        }),
      );
    });

    test('compiles composite filters (and / or)', () {
      final composite = CompositeFilterConstraint('or', [
        WhereConstraint('status', '==', 'pending'),
        WhereConstraint('status', '==', 'review'),
      ]);

      expect(
        composite.toMap(),
        equals({
          'kind': 'or',
          'filters': [
            {'kind': 'where', 'field': 'status', 'op': '==', 'value': 'pending'},
            {'kind': 'where', 'field': 'status', 'op': '==', 'value': 'review'},
          ],
        }),
      );
    });

    test('validates where operators and rejects invalid ones', () {
      expect(
        () => QueryCompiler.compileWhere('age', 'LIKE', 25),
        throwsArgumentError,
      );
    });

    test('validates limitToLast requires at least one orderBy clause', () {
      final collection = QueryCompiler.compileCollectionTarget('items');
      final invalidConstraints = [
        QueryCompiler.compileLimitToLast(5),
      ];

      expect(
        () => QueryCompiler.compileTargetDescriptor(
          source: collection,
          constraints: invalidConstraints,
        ),
        throwsArgumentError,
      );

      // Adding orderBy satisfies the requirement
      final validConstraints = [
        QueryCompiler.compileOrderBy('created'),
        QueryCompiler.compileLimitToLast(5),
      ];

      final target = QueryCompiler.compileTargetDescriptor(
        source: collection,
        constraints: validConstraints,
      );
      expect(target['__ref'], equals('query'));
    });
  });
}
