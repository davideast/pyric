import { row } from './section.ts';

export default row({
  order: 70,
  kind: 'observed',
  api: 'onRequest body parsing',
  behavior:
    'A JSON body that does not parse is refused before the handler runs, with the status, content type, and body production answers.',
  evidence: 'Production behavior needs `functions-http-onrequest-malformed-json`.',
});
