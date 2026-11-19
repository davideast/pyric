import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'oracle-backed',
  api: 'getAppCheck().createToken(appId)',
  featureKeys: ['createToken'],
  behavior: 'Resolves `{ token, ttlMillis: 3600000 }`; the token has the web SDK token shape (RS256 JWT with `kid`, claims `aud`, `exp`, `iat`, `iss`, `jti`, `lu`, `provider`, `sub`, `exp - iat` 3600).',
  evidence: 'capture `app-check-admin-create-token-shape`.',
  observations: ['app-check-admin-create-token-shape'],
  notes: 'Not claimed: token length. Production tokens were 1006 to 1008 characters; sandbox tokens are shorter, because the sandbox `kid`, `jti`, and `provider` values are shorter. The suite compares every other field of the shape and drops `length` explicitly. Also not claimed: the `lu` value. The captures record the claim\'s name only, so the sandbox\'s value is a placeholder.',
});
