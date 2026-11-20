import { SUITE, VITE_PLANE, WIRE_SERVING, row } from './section.ts';

export default row({
  order: 90,
  kind: 'upstream',
  api: 'callable ID token verification',
  behavior:
    'An ID token past its exp answers 401 {"error": {"message": "Unauthenticated", "status": "UNAUTHENTICATED"}}: firebase-admin rejects it with auth/id-token-expired, which the SDK reads as an invalid token.',
  evidence:
    'upstream: firebase-admin 13.10.0 `lib/auth/token-verifier.js:268` ("has expired") and `checkAuthToken` (`:331-334`). `verifySandboxIdToken` compares `exp` against the sandbox clock (`packages/pyric-admin/src/auth/token-decoders.ts`), and `buildFunctionsChildEnv` strips `FIREBASE_DEBUG_MODE` and `FIREBASE_DEBUG_FEATURES` so `skipTokenVerification` is never set in the child.',
  flip: { status: 'conforms', tests: [SUITE, WIRE_SERVING, VITE_PLANE] },
});
