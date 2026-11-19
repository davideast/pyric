import { SUITE, VITE_PLANE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  kind: 'pyric',
  api: 'onRequest(handler) / onRequest(options, handler)',
  behavior:
    'A discovered v2 onRequest export is served at /{projectId}/{region}/{name} on the sandbox server and the Vite dev server; the region comes from the options, then setGlobalOptions, then us-central1.',
  evidence:
    'upstream: the emulator routes /{projectId}/:region/:trigger_name (firebase-tools `lib/emulator/functionsEmulator.js:151-153`) and the SDK sets `__endpoint.httpsTrigger` and `region` (`lib/v2/providers/https.js:44-108`). Region resolution: `packages/cli/test/functions-http/discovery.test.ts`; the Vite plane: `packages/cli/test/functions-http/vite-plane.test.ts`.',
  flip: {
    status: 'conforms',
    tests: [SUITE, 'packages/cli/test/functions-http/discovery.test.ts', 'packages/cli/test/functions-http/routes.test.ts', VITE_PLANE],
  },
});
