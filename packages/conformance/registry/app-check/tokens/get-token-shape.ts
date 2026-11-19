import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'oracle-backed',
  api: 'getToken(appCheck, forceRefresh?): Promise<AppCheckTokenResult>',
  featureKeys: ['getToken', 'AppCheckTokenResult'],
  behavior: 'Resolves `{ token }` where `token` is a three-segment JWT: header `alg` RS256, `typ` JWT, with a `kid`; claims `aud`, `exp`, `iat`, `iss`, `jti`, `lu`, `provider`, `sub`; `iss` is `https://firebaseappcheck.googleapis.com/<projectNumber>`, `aud` is `[projects/<projectNumber>, projects/<projectId>]`, `sub` is the app id, and `exp - iat` is 3600 seconds.',
  evidence: 'capture `app-check-client-debug-get-token` (`first`, `forced`).',
  observations: ['app-check-client-debug-get-token'],
  notes: 'Not claimed: token length. Production tokens were 1006 to 1008 characters; sandbox tokens are shorter, because the sandbox `kid`, `jti`, and `provider` values are shorter. The suite compares every other field of the shape and drops `length` explicitly. Also not claimed: the `lu` value. The captures record the claim\'s name only, so the sandbox\'s value is a placeholder.',
});
