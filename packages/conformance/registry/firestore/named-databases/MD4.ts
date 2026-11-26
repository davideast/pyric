import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ['setRules'],
  api: 'Rules `match /databases/{database}/documents`',
  behavior:
    'Rules bind the `{database}` root wildcard and `request.path` to the active database id, match literal and multi-root `/databases/<id>/documents` blocks (leaving `database` unbound under literal roots), honor explicit Rules Test API `functionMocks`, and fail closed with an absorbable evaluation error on unmocked cross-database `get()`, `exists()`, `getAfter()`, and `existsAfter()` lookups while `|| true` still grants.',
  status: 'conforms',
  automation: 'oracle-backed',
  evidence:
    'Production captures `firestore-named-database-rules-api` (ADR-0021 C1) and `firestore-named-database-cross-database` (ADR-0021 C2) replayed in `packages/pyric/test/firestore/oracle-captures/firestore-named-database-rules-api.test.ts` and `firestore-named-database-cross-database.test.ts`, plus unit and sandbox coverage in `packages/rules/test/simulator/named-database-binding.test.ts` and `packages/pyric/test/firestore/named-database.test.ts`.',
  conformanceTests: [
    'packages/pyric/test/firestore/named-database.test.ts',
    'packages/pyric/test/firestore/oracle-captures/firestore-named-database-rules-api.test.ts',
    'packages/pyric/test/firestore/oracle-captures/firestore-named-database-cross-database.test.ts',
    'packages/rules/test/simulator/named-database-binding.test.ts',
  ],
  oracleObservations: [
    'firestore-named-database-rules-api',
    'firestore-named-database-cross-database',
  ],
  risk: ['security', 'stateful'],
  riskScore: 4,
  riskReasons: [
    'enforces per-database root match bindings and fail-closed cross-database lookup isolation',
  ],
});
