import { row } from './section.ts';

export default row({
  order: 50,
  kind: 'observed',
  api: 'callable request validation',
  behavior:
    'A request that is not POST, whose Content-Type is not application/json (a charset parameter is allowed), that has no body, whose JSON has no data key, or whose JSON has keys besides data answers 400 {"error": {"message": "Bad Request", "status": "INVALID_ARGUMENT"}} before the handler runs. {"data": null} is served. Malformed JSON gets the answer production\'s body parser gives, which the capture records.',
  evidence:
    'upstream: `isValidRequest` (`:126-154`) and the throw it guards (`:419-422`). The body parser runs before the SDK, in functions-framework-nodejs. Production behavior needs `functions-callable-bad-request`.',
});
