import { row } from './section.ts';

export default row({
  order: 210,
  kind: 'pyric',
  api: 'callable routing before the child is ready',
  behavior:
    'A call to a discovered callable while the Functions child is starting, reloading, failed, or waiting for a sandbox peer answers 503, so the client rejects with functions/unavailable (never not-found, internal, or a network error), and pyric\'s terminal names the cause.',
  evidence:
    'Pyric-owned lifecycle, shared with functions-http#20 (`packages/cli/src/functions/development-runtime.ts`, `functions/http/gateway.ts`). The client maps a 503 with no {error} body to unavailable (`codeForHTTPStatus`).',
});
