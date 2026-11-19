import { row } from './section.ts';

export default row({
  order: 150,
  kind: 'observed',
  api: 'functions.https.onCall(handler) (v1)',
  behavior:
    'A v1 functions.https.onCall export is served like v2: the handler gets (data, context) with context.rawRequest, context.auth, and context.app, and its return answers {"result"}. A v1 call with Accept: text/event-stream answers 400 {"error": {"message": "Unsupported Accept header \'text/event-stream\'", "status": "INVALID_ARGUMENT"}}.',
  evidence:
    'upstream: v1 sets `callableTrigger` with `platform: "gcfv1"` (`lib/v1/providers/https.js:52-79`) and the shared handler refuses streaming for gcfv1 (`:458-461`). Production behavior needs `functions-callable-v1`.',
});
