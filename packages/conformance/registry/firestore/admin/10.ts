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
  api: 'FieldValue.vector and unstubbed Query / CollectionReference / DocumentReference methods (select, offset, count, stream, findNearest, explain, explainStream, withConverter, listDocuments, listCollections)',
  behavior:
    'Vector sentinels (`FieldValue.vector`), query projections/offsets/streams/vector-search/explain/converters (`Query.{select, offset, count, stream, findNearest, explain, explainStream, withConverter}`), and reference discovery (`CollectionReference.listDocuments`, `DocumentReference.listCollections`) are not implemented or stubbed on sandbox handles and read as `undefined` at runtime.',
  status: 'unsupported',
  automation: 'unsupported',
  exceptionReason:
    'Vector embeddings, query projections/offsets/streams/explain/converters, and reference listing are not modeled in pyric-admin/firestore and are allowlisted as absent.',
  conformanceTests: ['packages/pyric-admin/test/surface/admin-surface.test.ts'],
  evidence:
    'Allowlisted and audited against `firebase-admin/firestore` in `packages/pyric-admin/test/surface/admin-surface.test.ts`.',
});
