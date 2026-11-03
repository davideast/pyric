import { callableBody, callableShape, type FunctionsCallableWireProbe } from '../../src/capture/functions-callable/probe-types.ts';

/** Every code an HttpsError accepts, `ok` included. */
const CODES = [
  'ok', 'cancelled', 'unknown', 'invalid-argument', 'deadline-exceeded', 'not-found', 'already-exists',
  'permission-denied', 'unauthenticated', 'resource-exhausted', 'failed-precondition', 'aborted',
  'out-of-range', 'unimplemented', 'internal', 'unavailable', 'data-loss',
];

/** functions-callable#3: each HttpsError code becomes its HTTP status and `{error:{status,message,details}}`. */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-https-error-codes',
  matrixRow: 'functions-callable #3',
  rowIds: ['functions-callable#3'],
  description:
    'A v2 onCall that throws new HttpsError(code, message, details) for every code, one without details, and one with an unknown code.',
  requests: [
    ...CODES.map((code) => ({
      id: code,
      function: 'pyricCallableEcho',
      via: 'cloudfunctions' as const,
      ...callableBody({ mode: 'throw', code, message: `pyric ${code}`, details: { code, n: 1 } }),
    })),
    {
      id: 'without-details',
      function: 'pyricCallableEcho',
      via: 'cloudfunctions',
      ...callableBody({ mode: 'throw', code: 'not-found', message: 'no details' }),
    },
    {
      id: 'unknown-code',
      function: 'pyricCallableEcho',
      via: 'cloudfunctions',
      ...callableBody({ mode: 'throw', code: 'not-a-code', message: 'unknown code' }),
    },
  ],
  behavior(responses) {
    return Object.fromEntries(Object.keys(responses).map((id) => [id, callableShape(responses[id])]));
  },
};
