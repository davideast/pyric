import { row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ['Auth.createSessionCookie', 'Auth.verifySessionCookie'],
  api: 'auth.createSessionCookie(idToken, options) / auth.verifySessionCookie(sessionCookie, checkRevoked?)',
  behavior:
    'HTTP session cookie minting and verification are not implemented in `pyric-admin/auth` and reject explicitly.',
  status: 'unsupported',
  automation: 'unsupported',
  exceptionReason:
    'Session cookie minting and verification are not yet implemented in pyric-admin/auth; calls reject explicitly.',
  conformanceTests: [
    'packages/pyric-admin/test/auth/local-auth.test.ts',
    'packages/pyric-admin/test/auth/remote-auth.test.ts',
  ],
  evidence: 'Explicitly rejected on both arms in `local-auth.test.ts` and `remote-auth.test.ts`.',
});
