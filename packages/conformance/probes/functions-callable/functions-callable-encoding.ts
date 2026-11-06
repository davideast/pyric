import { callableBody, callableShape, type FunctionsCallableWireProbe } from '../../src/capture/functions-callable/probe-types.ts';

const LONG = 'type.googleapis.com/google.protobuf.Int64Value';
const UNSIGNED_LONG = 'type.googleapis.com/google.protobuf.UInt64Value';
const RETURNED = ['date', 'nan', 'infinity', 'large-integer', 'nested'];

/**
 * functions-callable#2: the server's decode of Int64Value and UInt64Value
 * wrappers and of an unknown `@type`, and its encode of a Date, NaN,
 * Infinity, and an integer above 2^53.
 */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-encoding',
  matrixRow: 'functions-callable #2',
  rowIds: ['functions-callable#2'],
  description:
    'Wrapped 64-bit integers and an unknown @type sent as data, and Date, NaN, Infinity, a large integer, and a nested Date returned as result.',
  requests: [
    { id: 'int64', function: 'pyricCallableEcho', via: 'cloudfunctions', ...callableBody({ '@type': LONG, value: '9007199254740993' }) },
    {
      id: 'uint64',
      function: 'pyricCallableEcho',
      via: 'cloudfunctions',
      ...callableBody({ '@type': UNSIGNED_LONG, value: '18446744073709551615' }),
    },
    { id: 'int64-not-a-number', function: 'pyricCallableEcho', via: 'cloudfunctions', ...callableBody({ '@type': LONG, value: 'abc' }) },
    {
      id: 'unknown-type',
      function: 'pyricCallableEcho',
      via: 'cloudfunctions',
      ...callableBody({ '@type': 'type.googleapis.com/pyric.Unknown', value: '1' }),
    },
    ...RETURNED.map((value) => ({
      id: `return-${value}`,
      function: 'pyricCallableEcho',
      via: 'cloudfunctions' as const,
      ...callableBody({ mode: 'return', value }),
    })),
  ],
  behavior(responses) {
    return Object.fromEntries(Object.keys(responses).map((id) => [id, callableShape(responses[id])]));
  },
};
