import { row } from './section.ts';

export default row({
  order: 80,
  kind: 'observed',
  api: 'callable ID token verification',
  behavior:
    'A Bearer ID token whose signature does not verify, a Bearer value that is not a JWT, an Authorization scheme other than Bearer, and an ID token issued for another project (wrong aud) each answer 401 {"error": {"message": "Unauthenticated", "status": "UNAUTHENTICATED"}} before the handler runs, on v2 and v1, with or without enforceAppCheck.',
  evidence:
    'upstream: a failed `verifyIdToken` or a non-Bearer header is `INVALID`, which throws `unauthenticated` (`:313-316`, `:331-334`, `:441-443`). Owner decision (plan decision 3): no second project, so the wrong-audience case is stated from firebase-admin 13.10.0 `lib/auth/token-verifier.js:218-226` and not captured. `verifySandboxIdToken` checks the sandbox JWT tag and `aud` (`packages/pyric-admin/src/auth/token-decoders.ts`). Production behavior needs `functions-callable-auth-invalid`.',
});
