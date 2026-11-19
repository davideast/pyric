import { row } from './section.ts';

export default row({
  order: 50,
  kind: 'observed',
  api: 'req.body, req.rawBody',
  behavior: 'A JSON body is parsed to req.body, and req.rawBody holds the exact request bytes.',
  evidence:
    'upstream: functions-framework-nodejs parses json and saves rawBody; the emulator matches the parser order (`functionsEmulatorRuntime.js:543-561`). Production behavior needs `functions-http-onrequest-body-parsing`.',
});
