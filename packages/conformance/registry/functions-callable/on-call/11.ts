import { row } from './section.ts';

export default row({
  order: 110,
  kind: 'observed',
  api: 'onCall(handler) without enforceAppCheck',
  behavior:
    'Without enforceAppCheck, a call with a token that does not verify is served with request.app undefined, and so is a call with no token. A valid token still sets request.app (v1: context.app).',
  evidence:
    'upstream: an `INVALID` App Check result only logs "Allowing request with invalid AppCheck token because enforcement is disabled" (`:444-450`). Production behavior needs `functions-callable-app-check-unenforced`.',
});
