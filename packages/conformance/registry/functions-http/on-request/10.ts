import { row } from './section.ts';

export default row({
  order: 100,
  kind: 'observed',
  api: 'onRequest handler failure',
  behavior:
    'A handler that throws after sending headers and part of the body ends the response; the client receives what production shows.',
  evidence: 'Production behavior needs `functions-http-onrequest-headers-sent-failure`.',
});
