import { row } from './section.ts';

export default row({
  order: 130,
  kind: 'observed',
  api: 'onRequest({ cors }, handler)',
  behavior:
    'With cors unset, responses carry no CORS headers and an OPTIONS request reaches the handler, unlike the Functions emulator, which enables CORS for every onRequest function.',
  evidence:
    'upstream: the emulator forces `enableCors: true` unless `cors: false` (`functionsEmulator.js:990-993`, `https.js:55-57`). Production behavior needs `functions-http-onrequest-cors-unset`.',
});
