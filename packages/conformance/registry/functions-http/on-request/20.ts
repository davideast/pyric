import { SUITE, VITE_PLANE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 200,
  kind: 'pyric',
  api: 'onRequest routing',
  behavior:
    'A request to a discovered function while the child is starting, reloading, or waiting for a sandbox peer answers 503 with a message naming the cause, never a static 404.',
  evidence:
    'Pyric-owned lifecycle (`packages/cli/src/functions/development-runtime.ts`, `functions/http/gateway.ts`). Each cause (waiting for a peer, starting, reloading, failed) is pinned in `packages/cli/test/functions-http/gateway.test.ts`; both planes answer 503 on the emulator path and a hosting rewrite before a peer connects.',
  flip: { status: 'conforms', tests: [SUITE, 'packages/cli/test/functions-http/gateway.test.ts', VITE_PLANE] },
});
