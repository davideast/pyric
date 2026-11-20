import { row } from './section.ts';

export default row({
  order: 60,
  kind: 'observed',
  api: 'request.auth (v2), context.auth (v1)',
  behavior:
    'With Authorization: Bearer <valid ID token>, v2 request.auth and v1 context.auth have exactly the keys uid, token, and rawToken, and uid equals token.sub. token carries the claim names production\'s verifyIdToken returns (iss, aud, auth_time, user_id, sub, iat, exp, uid, and firebase with identities and sign_in_provider), with iss https://securetoken.google.com/<projectId> and aud <projectId>. The client SDK attaches the signed-in user\'s ID token to every call.',
  evidence:
    'upstream: `checkAuthToken` calls `getAuth(getApp()).verifyIdToken` and sets `{ uid, token, rawToken }` (`:308-335`). `verifySandboxIdToken` verifies `iss` `https://securetoken.google.com/<projectId>` and `aud` `<projectId>` (`packages/pyric-admin/src/auth/token-decoders.ts`). Production behavior needs `functions-callable-auth-valid` and `functions-callable-client-signed-in`.',
});
