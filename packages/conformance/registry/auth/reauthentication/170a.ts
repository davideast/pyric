import { row } from './section.ts';

export default row({
  order: 15,
  rowNumber: 170,
  featureKeys: ['reauthenticateWithCredential'],
  api: 'reauthenticateWithCredential(user, credential)',
  behavior:
    'When project-level Email Enumeration Protection is disabled (`sandbox.setEmailEnumerationProtection(auth, false)`), `reauthenticateWithCredential` throws `auth/wrong-password` for a wrong password on the signed-in account across in-page, SharedWorker, and registered Node host planes, while a credential belonging to a different account still throws `auth/user-mismatch` first.',
  status: 'conforms',
  evidence:
    '`unit:email-enumeration-protection.test.ts`, `unit:auth-email-enumeration-protection.test.ts` (SharedWorker + registered Node bridge).',
  risk: ['error-code'],
  riskScore: 4,
  riskReasons: ['asserts Firebase error code(s): `auth/wrong-password`, `auth/user-mismatch`'],
  automation: 'unit-backed',
  conformanceTests: [
    'packages/pyric/test/auth/sandbox/email-enumeration-protection.test.ts',
    'packages/cli/test/serve/worker/auth-email-enumeration-protection.test.ts',
    'packages/cli/test/register/auth-email-enumeration-protection.test.ts',
  ],
});
