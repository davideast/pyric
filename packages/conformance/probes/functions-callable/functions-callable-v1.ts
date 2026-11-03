import {
  callableBody,
  callableShape,
  type FunctionsCallableWireProbe,
} from '../../src/capture/functions-callable/probe-types.ts';

/**
 * functions-callable#15: a v1 `functions.https.onCall` export answers like v2,
 * its handler gets `(data, context)` with `context.rawRequest`, and
 * `Accept: text/event-stream` is refused with 400.
 */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-v1',
  matrixRow: 'functions-callable #15',
  rowIds: ['functions-callable#15'],
  description: 'A v1 https.onCall echo called with {data}, and called with Accept: text/event-stream.',
  requests: [
    { id: 'call', function: 'pyricCallableV1', via: 'cloudfunctions', ...callableBody({ v: 1 }) },
    {
      id: 'event-stream',
      function: 'pyricCallableV1',
      via: 'cloudfunctions',
      ...callableBody({ v: 1 }),
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    },
  ],
  behavior(responses) {
    return { call: callableShape(responses.call), eventStream: callableShape(responses['event-stream']) };
  },
};
