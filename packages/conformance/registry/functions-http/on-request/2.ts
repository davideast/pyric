import { row } from './section.ts';

export default row({
  order: 20,
  kind: 'observed',
  api: 'functions.https.onRequest(handler) (v1)',
  behavior:
    'v1 functions.https.onRequest and functions.region(r).https.onRequest exports are served the same way as v2, with us-central1 when no region is set.',
  evidence:
    'upstream: v1 sets the same `httpsTrigger` with `platform: "gcfv1"` (`lib/v1/providers/https.js:33-50`). Production behavior needs `functions-http-onrequest-v1`.',
});
