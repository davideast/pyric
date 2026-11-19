import { row } from './section.ts';

export default row({
  order: 90,
  kind: 'observed',
  api: 'onRequest handler failure',
  behavior: 'A handler that throws, or returns a rejected promise, before responding answers 500 Internal Server Error.',
  evidence:
    'upstream: `withErrorHandler` logs "Unhandled error" and answers 500 when headers are unsent (`lib/common/providers/https.js:563-574`). Production behavior needs `functions-http-onrequest-handler-failure`.',
});
