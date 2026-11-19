import { row } from './section.ts';

export default row({
  order: 50,
  flipped: 'oracle-backed',
  api: 'getLimitedUseToken(appCheck): Promise<AppCheckTokenResult>',
  featureKeys: ['getLimitedUseToken'],
  behavior: 'Resolves `{ token }` with the same JWT shape as `getToken` and a 300 second TTL, a different token on every call, never the cached token, and leaves the cached `getToken` token unchanged.',
  evidence: 'capture `app-check-client-limited-use-token` records the TTL in `ttlSeconds`, and the docs give a fixed 5 minutes (https://firebase.google.com/docs/ai-logic/app-check).',
  observations: ['app-check-client-limited-use-token'],
  notes: 'Not claimed: token length. Production tokens were 1006 to 1008 characters; sandbox tokens are shorter, because the sandbox `kid`, `jti`, and `provider` values are shorter. The suite compares every other field of the shape and drops `length` explicitly. Also not claimed: the `lu` value. The captures record the claim\'s name only, so the sandbox\'s value is a placeholder.',
});
