import { row } from './section.ts';

export default row({
  order: 35,
  rowNumber: 15,
  behavior:
    'When project-level Email Enumeration Protection is disabled (`sandbox.setEmailEnumerationProtection(auth, false)`), throws `auth/wrong-password` (`Firebase: Error (auth/wrong-password).`) when signing in via `signInWithEmailAndPassword` or `signInWithCredential` with a password that does not match the stored account (including passwordless accounts) across in-page, SharedWorker, and registered Node host planes, while disabled accounts still reject with `auth/user-disabled`.',
  status: 'conforms',
  evidence:
    '`unit:email-enumeration-protection.test.ts`, `unit:password-sign-in.test.ts`, `unit:auth-email-enumeration-protection.test.ts` (SharedWorker + registered Node bridge).',
  risk: ['specific-value', 'error-code'],
  riskScore: 5,
  riskReasons: ['asserts 1 specific value(s)', 'asserts Firebase error code(s): `auth/wrong-password`'],
  automation: 'unit-backed',
  conformanceTests: [
    'packages/pyric/test/auth/sandbox/email-enumeration-protection.test.ts',
    'packages/pyric/test/auth/sandbox/password-sign-in.test.ts',
    'packages/cli/test/serve/worker/auth-email-enumeration-protection.test.ts',
    'packages/cli/test/register/auth-email-enumeration-protection.test.ts',
  ],
});
