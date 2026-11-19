import { row } from './section.ts';

export default row({
  order: 140,
  kind: 'observed',
  api: 'onRequest({ cors }, handler)',
  behavior:
    'cors: true, a string list, and a RegExp answer preflights in the SDK middleware and reflect an allowed origin or omit the header for a denied one.',
  evidence:
    'upstream: the SDK wraps the handler in the `cors` package with `origin` from the option (`https.js:53-71`). Production behavior needs `functions-http-onrequest-cors-configured`.',
});
