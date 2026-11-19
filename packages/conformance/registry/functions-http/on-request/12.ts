import { row } from './section.ts';

export default row({
  order: 120,
  kind: 'observed',
  api: 'onRequest handler failure',
  behavior:
    'An exception thrown asynchronously outside the handler (a timer callback) has the production outcome for the request; RTDB triggers served by the same pyric child keep running.',
  evidence:
    'Owner decision: the shared pyric child catches the exception rather than restarting, because RTDB triggers run in it. Production behavior needs `functions-http-onrequest-uncaught-async`.',
});
