import { CLIENT, row } from './section.ts';

export default row({
  order: 180,
  kind: 'observed',
  api: 'FunctionsError',
  behavior:
    'For the answers in rows 3 to 10, the client rejects with a FunctionsError (name FirebaseError) whose code is functions/<code> from the body\'s status, or from the HTTP status when the body has none; whose message is "<message> [<httpStatus>]"; whose details are decoded from the body; and whose customData carries url. A plain throw gives functions/internal with message "INTERNAL [500]"; an enforced call with no App Check token gives functions/unauthenticated; an unknown function name gives the code production\'s 404 answer maps to. An HttpsError with code ok rejects with functions/internal "Response is missing data field.".',
  evidence: `upstream: \`codeForHTTPStatus\`, \`_errorForResponse\`, and \`callAtURL\` in ${CLIENT}; 0.14.0 appends " [<httpStatus>]" and customData.url, which 0.13.4 did not. Production behavior needs \`functions-callable-client-errors\`.`,
});
