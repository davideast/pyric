import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ['DocumentSnapshot.exists', 'DocumentSnapshot.data', 'DocumentSnapshot.get'],
  api: 'DocumentSnapshot.exists / data() / get(fieldPath)',
  behavior:
    'Exposes boolean `exists`, defensive-cloned `data()` (`undefined` when absent), and `get(fieldPath)` across one-shot, query, transaction, and listener snapshots for dotted field paths, literal-dot `FieldPath` segments, missing fields, and synchronous invalid-path validation.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['admin-firestore-document-snapshot-get'],
  conformanceTests: [
    'packages/pyric-admin/test/firestore/firestore/document-snapshot-get.test.ts',
    'packages/pyric-admin/test/firestore/snapshot-immutability.test.ts',
  ],
  evidence:
    'Production capture `admin-firestore-document-snapshot-get` (firebase-admin 13.10.0) replayed across all six read/listener surfaces by `document-snapshot-get.test.ts`, plus clone isolation in `snapshot-immutability.test.ts`.',
  risk: ['specific-value', 'error-code'],
  riskScore: 3,
  riskReasons: ['asserts field-path traversal and invalid-path throws'],
});
