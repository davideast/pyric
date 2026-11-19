import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: [
    'FieldValue.serverTimestamp',
    'FieldValue.increment',
    'FieldValue.arrayUnion',
    'FieldValue.arrayRemove',
    'FieldValue.delete',
    'FieldPath',
    'Timestamp',
  ],
  api: 'FieldValue.{serverTimestamp, increment, arrayUnion, arrayRemove, delete} / FieldPath / Timestamp / Uint8Array / DocumentReference values',
  behavior:
    'Supports `FieldValue.serverTimestamp()`, `increment()`, `arrayUnion()`, `arrayRemove()`, and `delete()`, `FieldPath` construction and `FieldPath.documentId()`, `Timestamp` range validation and round-trip, byte buffers, and stored `DocumentReference` values across local and remote arms (`FieldValue.vector` is absent; see `#10`).',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['firestore-admin-sentinels-and-value-types'],
  conformanceTests: [
    'packages/pyric-admin/test/firestore/oracle-conformance.test.ts',
    'packages/pyric-admin/test/firestore/reference-and-bytes-fields.test.ts',
    'packages/pyric-admin/test/firestore/field-path-queries.test.ts',
    'packages/pyric-admin/test/remote/remote-firestore-parity.test.ts',
  ],
  evidence:
    'Production capture `firestore-admin-sentinels-and-value-types` (firebase-admin 13.10.0) replayed across local and remote arms in `oracle-conformance.test.ts`, plus `reference-and-bytes-fields.test.ts`, `field-path-queries.test.ts`, and `remote-firestore-parity.test.ts`.',
  risk: ['specific-value'],
  riskScore: 2,
  riskReasons: ['asserts sentinel transforms and value-type round-trips'],
});
