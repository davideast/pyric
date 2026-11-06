import { corsShape, type FunctionsHttpProbe, type ProbeRequest } from '../../src/capture/functions-http/probe-types.ts';

const ALLOWED = 'https://allowed.example';
const DENIED = 'https://denied.example';

/** Each cors option form the fixture deploys: `true`, a string list, and a RegExp. */
const CONFIGURED: Record<string, string> = {
  true: 'pyricHttpCorsTrue',
  list: 'pyricHttpCorsList',
  regex: 'pyricHttpCorsRegex',
};

const requests: ProbeRequest[] = Object.entries(CONFIGURED).flatMap(([form, fn]): ProbeRequest[] => [
  {
    id: `${form}-preflight-allowed`,
    function: fn,
    via: 'cloudfunctions' as const,
    method: 'OPTIONS',
    headers: { origin: ALLOWED, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  },
  {
    id: `${form}-preflight-denied`,
    function: fn,
    via: 'cloudfunctions' as const,
    method: 'OPTIONS',
    headers: { origin: DENIED, 'access-control-request-method': 'POST' },
  },
  { id: `${form}-get-allowed`, function: fn, via: 'cloudfunctions' as const, headers: { origin: ALLOWED } },
  { id: `${form}-get-denied`, function: fn, via: 'cloudfunctions' as const, headers: { origin: DENIED } },
]);

/** functions-http#14: the SDK's cors middleware answers preflights and reflects or refuses origins. */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-onrequest-cors-configured',
  matrixRow: 'functions-http #14',
  rowIds: ['functions-http#14'],
  description:
    'Preflight and simple cross-origin requests from an allowed and a denied origin to v2 onRequest functions deployed with cors: true, a string list, and a RegExp.',
  requests,
  behavior(responses) {
    return Object.fromEntries(requests.map(({ id }) => [id, corsShape(responses[id])]));
  },
};
