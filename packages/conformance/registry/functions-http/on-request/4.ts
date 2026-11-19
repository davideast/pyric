import { row } from './section.ts';

export default row({
  order: 40,
  kind: 'observed',
  api: 'req.path, req.url, req.originalUrl, req.baseUrl',
  behavior:
    'The handler sees the path after the function name, with / for the function root, as production shows it on cloudfunctions.net and on the run.app URL.',
  evidence:
    'upstream: the emulator strips the /{project}/{region}/{name} prefix (`functionsEmulator.js:1264`). Production behavior needs `functions-http-onrequest-subpath`.',
});
