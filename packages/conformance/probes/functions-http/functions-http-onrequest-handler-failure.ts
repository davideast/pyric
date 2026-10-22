import { statusShape, type FunctionsHttpProbe } from '../../src/capture/functions-http/probe-types.ts';

/** functions-http#9: a handler that throws or rejects before responding. */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-onrequest-handler-failure',
  matrixRow: 'functions-http #9',
  rowIds: ['functions-http#9'],
  description:
    'A v2 onRequest handler that throws synchronously, or returns a rejected promise, before sending anything.',
  requests: [
    { id: 'sync', function: 'pyricHttpThrow', via: 'cloudfunctions', path: '?mode=sync' },
    { id: 'reject', function: 'pyricHttpThrow', via: 'cloudfunctions', path: '?mode=reject' },
  ],
  behavior(responses) {
    return { sync: statusShape(responses.sync), reject: statusShape(responses.reject) };
  },
};
