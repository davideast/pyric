import { row } from './section.ts';

export default row({
  order: 60,
  kind: 'observed',
  api: 'req.body, req.rawBody',
  behavior:
    'text, urlencoded (extended), octet-stream, an unknown content type, no content type, and an empty body map to req.body and req.rawBody as production maps them.',
  evidence: 'Production behavior needs `functions-http-onrequest-body-parsing`.',
});
