import { row } from './section.ts';

export default row({
  order: 30,
  kind: 'observed',
  api: 'HttpsError(code, message, details)',
  behavior:
    'Each code answers its HTTP status: ok 200, cancelled 499, unknown 500, invalid-argument 400, deadline-exceeded 504, not-found 404, already-exists 409, permission-denied 403, unauthenticated 401, resource-exhausted 429, failed-precondition 400, aborted 409, out-of-range 400, unimplemented 501, internal 500, unavailable 503, data-loss 500. The body is {"error": {"message", "status": "<CANONICAL_NAME>", "details"}}, with details omitted when the handler passed none. An unknown code throws in the HttpsError constructor and answers 500 INTERNAL.',
  evidence:
    'upstream: `errorCodeMap` and `HttpsError.toJSON` (`:29-124`), and the catch that answers `res.status(status).send({ error })` (`:528-542`). Production behavior needs `functions-callable-https-error-codes`.',
});
