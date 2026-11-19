import { row } from './section.ts';

export default row({
  order: 90,
  flipped: 'oracle-backed',
  extraTests: [
    'packages/cli/test/register/app-bridge-admin-app-check.test.ts',
    'packages/pyric-admin/test/app-check/firebase-token.test.ts',
    'test/apps/ai-production-app-check/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'APP-CHECK-ADMIN-VERIFY-PROD-AI',
      observation: 'app-check-admin-verify-token',
      expect: {
        debugExchanged: {
          resultKeySet: ['appId', 'token'],
          appIdEqualsConfig: true,
          decodedClaimNames: ['app_id', 'aud', 'exp', 'iat', 'iss', 'jti', 'lu', 'provider', 'sub'],
          decodedAppIdEqualsConfig: true,
          alreadyConsumed: null,
        },
      },
      probe: 'packages/pyric-admin/test/app-check/oracle-conformance.test.ts',
      guards:
        'getAppCheck().verifyToken(firebaseToken) under @pyric/cli/register in production AI mode delegates foreign-kid tokens to firebase-admin and resolves the production result shape.',
    },
  ],
  api: 'getAppCheck().verifyToken(firebaseToken) under @pyric/cli/register in production AI mode',
  featureKeys: ['verifyToken'],
  behavior: 'A token whose `kid` names a key other than the sandbox\'s goes to firebase-admin\'s own `verifyToken`, for an app scoped to the project the mirror resolves. It resolves with production\'s `{ appId, token }` shape, the decoded token carrying `app_id`, and firebase-admin\'s errors (signature, audience, issuer, expiry) pass through with their codes and messages. Sandbox tokens, tokens with no `kid`, and malformed tokens keep the sandbox path.',
  evidence: 'capture `app-check-admin-verify-token` (`debugExchanged`), replayed against firebase-admin 13.10.0 `lib/app-check/token-verifier.js` in `packages/pyric-admin/test/app-check/oracle-conformance.test.ts`, under `node --import @pyric/cli/register` in `packages/cli/test/register/app-bridge-admin-app-check.test.ts`, in `packages/pyric-admin/test/app-check/firebase-token.test.ts`, and in `test/apps/ai-production-app-check/scenario.ts`.',
  observations: ['app-check-admin-verify-token'],
  notes: 'The verifier\'s firebase-admin app holds no credentials: the only request it makes is the unauthenticated `GET https://firebaseappcheck.googleapis.com/v1/jwks`, cached for six hours. firebase-admin must be installed beside the server; without it the first such token rejects with `app-check/invalid-argument` and a message naming `npm install firebase-admin`. Not covered: live attestation exchange against Google\'s App Check servers during local runs; JWKS public-key delivery is stood in locally with an RS256 key pair while firebase-admin runs unchanged.',
});
