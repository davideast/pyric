import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: [
    'FieldValue.vector',
    'Query.select',
    'Query.offset',
    'Query.count',
    'Query.stream',
    'Query.findNearest',
    'Query.explain',
    'Query.explainStream',
    'Query.withConverter',
    'CollectionReference.listDocuments',
    'DocumentReference.listCollections',
  ],
  api: 'FieldValue.vector, Query.{select, offset, count, stream, findNearest, explain, explainStream, withConverter}, CollectionReference.listDocuments, and DocumentReference.listCollections',
  behavior:
    'Supports `FieldValue.vector` (`VectorValue` `.toArray()`, `.isEqual()`, and lossless write/read roundtrip), `Query.{select, offset, count, stream, findNearest, explain, explainStream, withConverter}`, `CollectionReference.{withConverter, listDocuments}` (including phantom parent document references holding subcollections), and `DocumentReference.{withConverter, listCollections}` across local and remote sandboxes.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['firestore-admin-vector-query-and-discovery'],
  conformanceTests: [
    'packages/pyric-admin/test/firestore/oracle-conformance.test.ts',
    'packages/pyric-admin/test/firestore/admin-vector-and-errors.test.ts',
    'packages/pyric-admin/test/firestore/admin-query-extensions.test.ts',
    'packages/pyric-admin/test/firestore/admin-vector-query.test.ts',
    'packages/pyric-admin/test/firestore/admin-converter-and-discovery.test.ts',
    'packages/pyric-admin/test/surface/admin-surface.test.ts',
  ],
  evidence:
    'Production capture `firestore-admin-vector-query-and-discovery` (firebase-admin 13.10.0) replayed across local and remote arms in `oracle-conformance.test.ts`, plus two-arm k-NN (`EUCLIDEAN`, `COSINE`, `DOT_PRODUCT`) and converter/discovery unit tests.',
  risk: ['stateful'],
  riskScore: 3,
  riskReasons: ['asserts vector roundtrip, projections/offsets/streams/explain, converter transforms, and phantom document discovery across local and remote arms'],
});
