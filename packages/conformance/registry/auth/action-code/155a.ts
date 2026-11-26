import { row } from './section.ts';

export default row({
  order: 65,
  rowNumber: 155,
  featureKeys: ['sendPasswordResetEmail'],
  api: 'sendPasswordResetEmail(auth, email)',
  behavior:
    'When project-level Email Enumeration Protection is disabled (`sandbox.setEmailEnumerationProtection(auth, false)`), `sendPasswordResetEmail` throws `auth/user-not-found` (`Firebase: Error (auth/user-not-found).`) without emitting reset mail when no account owns `email` in the active tenant across in-page, SharedWorker, and registered Node host planes; malformed addresses still throw `auth/invalid-email`.',
  status: 'conforms',
  evidence:
    '`unit:email-enumeration-protection.test.ts`, `unit:auth-email-enumeration-protection.test.ts` (SharedWorker + registered Node bridge).',
  risk: ['error-code'],
  riskScore: 4,
  riskReasons: ['asserts Firebase error code(s): `auth/user-not-found`, `auth/invalid-email`'],
  automation: 'unit-backed',
  conformanceTests: [
    'packages/pyric/test/auth/sandbox/email-enumeration-protection.test.ts',
    'packages/cli/test/serve/worker/auth-email-enumeration-protection.test.ts',
    'packages/cli/test/register/auth-email-enumeration-protection.test.ts',
  ],
});
