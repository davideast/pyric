import { row } from './section.ts';

export default row({
  order: 40,
  flipped: 'oracle-backed',
  api: 'getAppCheck().verifyToken(token)',
  featureKeys: ['verifyToken'],
  behavior: 'Resolves `{ appId, token }` for an Admin-minted token and for a token from the web debug exchange; the decoded token carries `app_id`, `aud`, `exp`, `iat`, `iss`, `jti`, `provider`, `sub`, and no `alreadyConsumed` key is present.',
  evidence: 'capture `app-check-admin-verify-token`.',
  observations: ['app-check-admin-verify-token'],
});
