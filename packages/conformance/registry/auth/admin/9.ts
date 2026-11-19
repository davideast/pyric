import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ['Auth.listUsers'],
  api: 'auth.listUsers(maxResults?, pageToken?)',
  behavior:
    'Lists `UserRecord` entries in pages up to `maxResults` (1..1000, default 1000) with exclusive UID keyset cursor pagination via `pageToken` across local and remote arms, advancing without skipping or duplicating surviving users when the last-returned or next-boundary user is deleted between pages.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['admin-auth-listusers-deleted-cursor'],
  conformanceTests: [
    'packages/pyric-admin/test/auth/oracle-conformance.test.ts',
    'packages/pyric-admin/test/auth/local-auth.test.ts',
    'packages/pyric-admin/test/auth/remote-auth.test.ts',
    'packages/pyric-admin/test/auth/validation.test.ts',
  ],
  evidence:
    'Production capture `admin-auth-listusers-deleted-cursor` (firebase-admin 13.10.0) replayed across local and remote worker-bridge arms by `oracle-conformance.test.ts`, `local-auth.test.ts`, `remote-auth.test.ts`, and `validation.test.ts`.',
  risk: ['specific-value'],
  riskScore: 2,
  riskReasons: ['asserts page boundaries, deleted-cursor progression, and pageToken validation'],
});
