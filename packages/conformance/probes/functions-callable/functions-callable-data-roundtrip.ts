import { callableBody, callableShape, type FunctionsCallableWireProbe } from '../../src/capture/functions-callable/probe-types.ts';

/** Each JSON value kind a client sends as `data`. */
const SENT: Record<string, unknown> = {
  object: { a: 1, nested: { b: [true, 'x'] } },
  string: 'pyric',
  number: 42.5,
  boolean: false,
  array: [1, 'two', null],
  null: null,
};

/** functions-callable#1: `{data}` in, `{result}` out, with `null` and `undefined`. */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-data-roundtrip',
  matrixRow: 'functions-callable #1',
  rowIds: ['functions-callable#1'],
  description:
    'POSTs of {data} for each JSON value kind to a v2 onCall echo, and the {result} answer when the handler returns null or undefined.',
  requests: [
    ...Object.entries(SENT).map(([id, data]) => ({
      id: `sent-${id}`,
      function: 'pyricCallableEcho',
      via: 'cloudfunctions' as const,
      ...callableBody(data),
    })),
    { id: 'return-null', function: 'pyricCallableEcho', via: 'cloudfunctions', ...callableBody({ mode: 'return', value: 'null' }) },
    {
      id: 'return-undefined',
      function: 'pyricCallableEcho',
      via: 'cloudfunctions',
      ...callableBody({ mode: 'return', value: 'undefined' }),
    },
  ],
  behavior(responses) {
    return Object.fromEntries(Object.keys(responses).map((id) => [id, callableShape(responses[id])]));
  },
};
