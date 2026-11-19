import { row } from './section.ts';

export default row({
  order: 40,
  kind: 'observed',
  api: 'onCall handler failure',
  behavior:
    'A handler that throws an Error, returns a rejected promise, or throws a value that is not an Error answers 500 {"error": {"message": "INTERNAL", "status": "INTERNAL"}} on v2 and v1. The thrown message never reaches the client.',
  evidence:
    'upstream: a throw that is not an HttpsError is logged as "Unhandled error" and replaced by `new HttpsError("internal", "INTERNAL")` (`:530-534`). Production behavior needs `functions-callable-plain-throw`.',
});
