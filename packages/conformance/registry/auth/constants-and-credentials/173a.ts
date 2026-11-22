import { row } from './section.ts';

export default row({
  order: 35,
  rowNumber: 173,
  featureKeys: ['signInWithCustomToken'],
  api: 'signInWithCustomToken(auth, customToken)',
  behavior:
    'Refuses a sandbox ID token (`user.getIdToken()`) with `auth/invalid-custom-token` across in-page, SharedWorker, and Node-hosted planes without signing in or mutating `currentUser`: an ID token carries the project id as `aud` and `https://securetoken.google.com/<projectId>` as `iss` rather than the Identity Toolkit custom-token audience and service-account issuer.',
  status: 'conforms',
  evidence:
    'Oracle `auth-signinwithcustomtoken-invalid` locks `auth/invalid-custom-token` for tokens that are not valid Identity Toolkit custom tokens; `packages/pyric/test/auth/custom-token-id-token-refusal.test.ts` and `packages/cli/test/serve/worker/auth-sdk-results-tokens-parity.test.ts` verify refusal of minted sandbox ID tokens on in-page and served worker/host planes (including when blocking hooks are active).',
  risk: ['error-code'],
  riskScore: 4,
  riskReasons: ['asserts Firebase error code(s): `auth/invalid-custom-token`'],
  automation: 'unit-backed',
  conformanceTests: [
    'packages/pyric/test/auth/custom-token-id-token-refusal.test.ts',
    'packages/cli/test/serve/worker/auth-sdk-results-tokens-parity.test.ts',
  ],
});
