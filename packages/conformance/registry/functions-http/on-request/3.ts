import { row } from './section.ts';

export default row({
  order: 30,
  kind: 'observed',
  api: 'req.method, req.query, req.headers',
  behavior:
    'The request method, the parsed query (repeated and bracketed keys), and the request headers reach the handler; the names of the headers production adds or strips match.',
  evidence: 'Production behavior needs `functions-http-onrequest-basic-get`.',
});
