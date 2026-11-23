import { row } from './section.ts';

export default row({
  order: 150,
  kind: 'observed',
  api: 'onRequest({ invoker }, handler)',
  behavior:
    "When a function sets an invoker other than 'public', such as invoker: 'private' or a service account, production refuses unauthenticated calls with 403, and pyric serves it without authentication to the app's own pages and to callers that are not browser pages, such as curl or server code. Pyric refuses another browser page (a foreign Origin, or Sec-Fetch-Site cross-site or same-site with no Origin) with 403, warns once per function, and records the difference as a by-design divergence.",
  evidence:
    'upstream: the emulator never enforces `invoker` (no reference in `lib/emulator`). Owner decision: serve and warn. Production behavior needs `functions-http-onrequest-invoker-private`.',
});
