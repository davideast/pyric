import type { FunctionsHttpProbe, ProbeRequest, ProbeResponse } from '../../src/capture/functions-http/probe-types.ts';

const SHAPES = ['json', 'redirect', 'status', 'empty', 'cookies', 'stream'];

const requests: ProbeRequest[] = [
  ...SHAPES.map((shape) => ({
    id: shape,
    function: 'pyricHttpResponses',
    via: 'cloudfunctions' as const,
    path: `?shape=${shape}`,
    headers: { 'x-pyric-probe': 'response-shapes' },
  })),
  { id: 'echo', function: 'pyricHttpEcho', via: 'cloudfunctions' },
];

function shape(response: ProbeResponse): Record<string, unknown> {
  return {
    status: response.status,
    contentType: response.headers['content-type'] ?? null,
    location: response.headers.location ?? null,
    setCookie: response.headers['set-cookie'] ?? null,
    custom: response.headers['x-pyric-custom'] ?? null,
    poweredBy: response.headers['x-powered-by'] ?? null,
    body: response.body,
  };
}

/** functions-http#8: status, headers, JSON, redirects, cookies, and streamed chunks arrive as sent. */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-onrequest-response-shapes',
  matrixRow: 'functions-http #8',
  rowIds: ['functions-http#8'],
  description:
    'Responses a v2 onRequest handler sends with res.status, res.set, res.json, res.redirect, res.cookie, res.end, and streamed res.write chunks, as the client receives them.',
  requests,
  behavior(responses) {
    return Object.fromEntries(requests.map(({ id }) => [id, shape(responses[id])]));
  },
};
