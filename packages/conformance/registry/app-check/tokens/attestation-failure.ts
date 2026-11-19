import { row } from './section.ts';

export default row({
  order: 60,
  api: 'getToken / getLimitedUseToken when attestation fails',
  featureKeys: ['getToken', 'getLimitedUseToken'],
  behavior: 'When the exchange is refused (an unregistered debug token), both reject with a `FirebaseError` with code `appCheck/fetch-status-error` and `customData.httpStatus` 403.',
  evidence: 'capture `app-check-client-invalid-debug-token` (`getToken`, `getLimitedUseToken`).',
  observations: ['app-check-client-invalid-debug-token'],
  errorText: true,
  unsupportedReason: 'The sandbox has no attestation authority that can refuse a token, so every request succeeds; a knob that simulates refusal is a candidate, not a commitment. Production pass-through runs the real SDK and inherits this behavior.',
});
