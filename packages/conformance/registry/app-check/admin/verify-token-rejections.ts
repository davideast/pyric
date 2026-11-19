import { row } from './section.ts';

export default row({
  order: 50,
  flipped: 'oracle-backed',
  api: 'getAppCheck().verifyToken(badToken)',
  featureKeys: ['verifyToken'],
  behavior: 'A token with an altered signature rejects with `app-check/invalid-argument` and `The provided App Check token has invalid signature.`; a non-JWT string and the empty string reject with `app-check/invalid-argument` and the decoding message.',
  evidence: 'capture `app-check-admin-verify-tampered`.',
  observations: ['app-check-admin-verify-tampered'],
  errorText: true,
});
