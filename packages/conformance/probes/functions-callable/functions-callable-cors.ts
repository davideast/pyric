import {
  callableBody,
  type CallableProbeRequest,
  type FunctionsCallableWireProbe,
  type ProbeResponse,
} from '../../src/capture/functions-callable/probe-types.ts';

const ORIGIN = 'https://any-app.example';
const FUNCTIONS: Record<string, string> = { v2: 'pyricCallableEcho', v1: 'pyricCallableV1' };

const requests: CallableProbeRequest[] = Object.entries(FUNCTIONS).flatMap(([version, fn]): CallableProbeRequest[] => [
  {
    id: `${version}-preflight`,
    function: fn,
    via: 'cloudfunctions',
    method: 'OPTIONS',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type,x-firebase-appcheck',
    },
  },
  { id: `${version}-post`, function: fn, via: 'cloudfunctions', ...callableBody({}), headers: { 'content-type': 'application/json', origin: ORIGIN } },
]);

function corsAnswer(response: ProbeResponse): Record<string, unknown> {
  return {
    status: response.status,
    allowOrigin: response.headers['access-control-allow-origin'] ?? null,
    allowMethods: response.headers['access-control-allow-methods'] ?? null,
    allowHeaders: response.headers['access-control-allow-headers'] ?? null,
    allowCredentials: response.headers['access-control-allow-credentials'] ?? null,
    vary: response.headers.vary ?? null,
    body: response.body,
  };
}

/** functions-callable#13: the default CORS answer of a v2 (`cors` unset, so true) and a v1 callable. */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-cors',
  matrixRow: 'functions-callable #13',
  rowIds: ['functions-callable#13'],
  description:
    'A preflight that asks for the headers the client SDK sends, and a cross-origin POST, to a v2 onCall with cors unset and to a v1 onCall.',
  requests,
  behavior(responses) {
    return Object.fromEntries(requests.map(({ id }) => [id, corsAnswer(responses[id])]));
  },
};
