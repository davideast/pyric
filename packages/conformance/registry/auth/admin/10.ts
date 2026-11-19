import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: [
    'Auth.getUserByPhoneNumber',
    'Auth.getUserByProviderUid',
    'Auth.getUsers',
    'Auth.deleteUsers',
    'Auth.importUsers',
  ],
  api: 'auth.getUserByPhoneNumber / getUserByProviderUid / getUsers / deleteUsers / importUsers',
  behavior:
    'Bulk user lookup, batch deletion, hash-imported user migration, and phone/provider-UID lookups are not implemented in `pyric-admin/auth` and reject explicitly.',
  status: 'unsupported',
  automation: 'unsupported',
  exceptionReason:
    'Bulk user import/delete/lookup and phone/provider-UID queries are not yet implemented in pyric-admin/auth; calls reject explicitly.',
  conformanceTests: [
    'packages/pyric-admin/test/auth/local-auth.test.ts',
    'packages/pyric-admin/test/auth/remote-auth.test.ts',
  ],
  evidence: 'Explicitly rejected on both arms in `local-auth.test.ts` and `remote-auth.test.ts`.',
});
