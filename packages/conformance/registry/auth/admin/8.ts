import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ['Auth.updateUser'],
  api: 'auth.updateUser(uid, properties)',
  behavior:
    'Updates email, password, `emailVerified`, `displayName`, `photoURL`, `phoneNumber` (including `null` profile/phone clears and `phone` `providerData` addition/removal), and `disabled` flags across local and remote arms; `multiFactor`, `providerToLink`, and `providersToUnlink` properties are not modeled and reject explicitly.',
  status: 'diverged-documented',
  statusNote:
    'profile, credential, phone, and disabled fields update; multiFactor, providerToLink, and providersToUnlink reject as unimplemented',
  automation: 'oracle-backed',
  oracleObservations: ['admin-auth-update-user-fields'],
  conformanceTests: [
    'packages/pyric-admin/test/auth/oracle-conformance.test.ts',
    'packages/pyric-admin/test/auth/local-auth.test.ts',
    'packages/pyric-admin/test/auth/remote-auth.test.ts',
    'packages/pyric-admin/test/auth/validation.test.ts',
  ],
  evidence:
    'Production capture `admin-auth-update-user-fields` (firebase-admin 13.10.0) replayed across local and remote worker-bridge arms by `oracle-conformance.test.ts`, plus unmodeled-property checks in `local-auth.test.ts`, `remote-auth.test.ts`, and `validation.test.ts`.',
  risk: ['stateful'],
  riskScore: 2,
  riskReasons: ['asserts UpdateRequest field mutations, null clears, and unmodeled-key rejections'],
});
