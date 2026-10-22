import { corsShape, type FunctionsHttpProbe } from '../../src/capture/functions-http/probe-types.ts';

const ORIGIN = 'https://allowed.example';

/** functions-http#13: with `cors` unset, no CORS headers and OPTIONS reaches the handler. */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-onrequest-cors-unset',
  matrixRow: 'functions-http #13',
  rowIds: ['functions-http#13'],
  description:
    'A preflight OPTIONS and a cross-origin GET to a v2 onRequest function deployed without the cors option.',
  requests: [
    {
      id: 'preflight',
      function: 'pyricHttpEcho',
      via: 'cloudfunctions',
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    },
    { id: 'get', function: 'pyricHttpEcho', via: 'cloudfunctions', headers: { origin: ORIGIN } },
  ],
  behavior(responses) {
    return { preflight: corsShape(responses.preflight), get: corsShape(responses.get) };
  },
};
