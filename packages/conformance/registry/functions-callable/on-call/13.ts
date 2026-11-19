import { row } from './section.ts';

export default row({
  order: 130,
  kind: 'observed',
  api: 'onCall({ cors }, handler)',
  behavior:
    'A v2 onCall with cors unset uses cors: true: a preflight from any origin answers with Access-Control-Allow-Origin reflecting that origin, Access-Control-Allow-Methods POST, and the requested headers (authorization, content-type, x-firebase-appcheck) allowed, and a cross-origin POST reflects the origin. A v1 onCall answers the same way. The capture records the status and any headers the platform adds.',
  evidence:
    'upstream: v2 defaults `cors` to true with `methods: "POST"` (`lib/v2/providers/https.js:117-144`); v1 always uses `origin: true` (`lib/v1/providers/https.js:56-63`); the `cors` middleware runs before the handler (`:377-386`). Production behavior needs `functions-callable-cors`.',
});
