import { row } from './section.ts';

export default row({
  order: 110,
  kind: 'observed',
  api: 'onRequest({ timeoutSeconds }, handler)',
  behavior:
    'A handler that never responds is cut at timeoutSeconds (60 when unset) with the status production answers.',
  evidence:
    'upstream: the emulator defaults timeoutSeconds to 60 (`functionsEmulatorShared.js:97`) and destroys the socket on expiry (`functionsRuntimeWorker.js:115-141`), which production need not match. Production behavior needs `functions-http-onrequest-no-response-timeout`.',
});
