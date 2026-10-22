import { statusShape, type FunctionsHttpProbe } from '../../src/capture/functions-http/probe-types.ts';

/** functions-http#10: a handler that fails after it has sent headers and part of the body. */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-onrequest-headers-sent-failure',
  matrixRow: 'functions-http #10',
  rowIds: ['functions-http#10'],
  description:
    'A v2 onRequest handler that writes status 200 and a partial body, then throws or rejects; what the client receives.',
  requests: [
    { id: 'sync', function: 'pyricHttpThrowAfterHeaders', via: 'cloudfunctions', path: '?mode=sync', clientTimeoutMs: 30_000 },
    { id: 'reject', function: 'pyricHttpThrowAfterHeaders', via: 'cloudfunctions', path: '?mode=reject', clientTimeoutMs: 30_000 },
  ],
  behavior(responses) {
    return { sync: statusShape(responses.sync), reject: statusShape(responses.reject) };
  },
};
