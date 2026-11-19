import { row } from './section.ts';

export default row({
  order: 90,
  kind: 'upstream',
  api: 'callable ID token verification',
  behavior:
    'An ID token past its exp answers 401 {"error": {"message": "Unauthenticated", "status": "UNAUTHENTICATED"}}: firebase-admin rejects it with auth/id-token-expired, which the SDK reads as an invalid token.',
  evidence:
    'upstream: firebase-admin 13.10.0 `lib/auth/token-verifier.js:268` ("has expired") and `checkAuthToken` (`:331-334`). Pyric today: `verifySandboxIdToken` never compares exp with the clock; plan decision 1 adds the check against the sandbox clock. The SDK debug feature `skipTokenVerification` must never be set in the child.',
});
