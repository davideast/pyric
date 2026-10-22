import { echoOf, type FunctionsHttpProbe } from '../../src/capture/functions-http/probe-types.ts';

const COOKIE = '__session=pyric-session; pyric_other=dropped';

/**
 * functions-http#17: firebase.json hosting rewrites to a function, by bare
 * id, by `{functionId, region}`, and to a v1 function.
 */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-hosting-rewrite',
  matrixRow: 'functions-http #17',
  rowIds: ['functions-http#17'],
  description:
    'Requests to Hosting paths rewritten to onRequest functions: the path, query, cookies, and forwarding headers the handler sees.',
  requests: [
    {
      id: 'api',
      function: 'pyricHttpEcho',
      via: 'hosting',
      path: '/api/items/42?x=1',
      headers: { cookie: COOKIE, 'x-pyric-probe': 'hosting-rewrite' },
    },
    { id: 'api-post', function: 'pyricHttpEcho', via: 'hosting', method: 'POST', path: '/api/items', headers: { 'content-type': 'application/json' }, body: '{"via":"hosting"}' },
    { id: 'regional', function: 'pyricHttpRegional', region: 'us-east1', via: 'hosting', path: '/east/here' },
    { id: 'legacy', function: 'pyricHttpV1', via: 'hosting', path: '/legacy/old?y=2' },
  ],
  behavior(responses) {
    const view = (id: string) => {
      const response = responses[id];
      const echo = response.status === 200 ? echoOf(response) : null;
      return {
        status: response.status,
        path: echo?.path ?? null,
        url: echo?.url ?? null,
        query: echo?.query ?? null,
        body: echo?.body ?? null,
        cookie: echo?.headerValues.cookie ?? null,
        forwardedHostPresent: echo?.headerValues['x-forwarded-host'] !== undefined,
        originalUrl: echo?.headerValues['x-original-url'] ?? null,
        headerNames: echo?.headerNames ?? null,
      };
    };
    return { api: view('api'), apiPost: view('api-post'), regional: view('regional'), legacy: view('legacy') };
  },
};
