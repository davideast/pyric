import { row } from './section.ts';

export default row({
  order: 100,
  kind: 'observed',
  api: 'onCall({ enforceAppCheck: true }, handler)',
  behavior:
    'With enforceAppCheck: true (from the options, else setGlobalOptions), a call with no X-Firebase-AppCheck header, or with a token that does not verify, answers 401 {"error": {"message": "Unauthenticated", "status": "UNAUTHENTICATED"}} before the handler runs. A valid token reaches the handler as request.app with appId and token.',
  evidence:
    'upstream: `checkAppCheckToken` calls `getAppCheck(getApp()).verifyToken` (`:337-375`) and enforcement throws on `INVALID` or `MISSING` (`:444-453`); v2 resolves `enforceAppCheck` from the options, then global options (`lib/v2/providers/https.js:132`). Production behavior needs `functions-callable-app-check-enforced`.',
});
