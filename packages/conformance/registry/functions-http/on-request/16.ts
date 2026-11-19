import { row } from './section.ts';

export default row({
  order: 160,
  kind: 'observed',
  api: 'onRequest routing',
  behavior: 'A request for a function name the project does not define answers with the production 404 shape.',
  evidence:
    'upstream: the emulator answers `404 Function X does not exist, valid functions are: ...` (`functionsEmulator.js:1233-1247`). Production behavior needs `functions-http-onrequest-not-found`.',
});
