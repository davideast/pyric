import { row } from './section.ts';

export default row({
  order: 150,
  kind: 'observed',
  api: "onRequest({ invoker: 'private' }, handler)",
  behavior:
    "Production refuses an unauthenticated call to an invoker: 'private' function with 403. Pyric serves it without authentication to the app's own pages and to callers that are not browser pages, refuses another page (a foreign Origin, or Sec-Fetch-Site cross-site or same-site with no Origin) with 403, warns once per function, and records the difference as a by-design divergence.",
  evidence:
    'upstream: the emulator never enforces `invoker` (no reference in `lib/emulator`). Owner decision: serve and warn. Production behavior needs `functions-http-onrequest-invoker-private`.',
});
