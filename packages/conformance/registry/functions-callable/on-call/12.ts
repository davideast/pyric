import { row } from './section.ts';

export default row({
  order: 120,
  kind: 'observed',
  api: 'onCall({ consumeAppCheckToken: true }, handler)',
  behavior:
    'With consumeAppCheckToken: true, request.app.alreadyConsumed is false on the first use of a limited-use token and true on its second. The capture also records what a regular token reports. Pyric keeps the consumed set per process (#1297), so the Functions child and the page track consumed tokens separately.',
  evidence:
    'upstream: `verifyToken(token, { consume: true })` (`:355-361`) and firebase-admin 13.10.0 `lib/app-check/app-check.js:76-80`. pyric-admin `verifyToken(token, options?)` has arity 2, so the SDK\'s "Unsupported version of the Admin SDK" check passes. Owner decision (plan decision 8): accept the per-process set for now. Production behavior needs `functions-callable-app-check-consume` and `functions-callable-client-limited-use`.',
});
