import { echoOf, type FunctionsHttpProbe, type ProbeRequest } from '../../src/capture/functions-http/probe-types.ts';

const CLOUDFUNCTIONS_PATHS: Record<string, string> = {
  bare: '',
  root: '/',
  nested: '/a/b',
  trailing: '/a/b/?x=1',
  encoded: '/%E2%9C%93/space%20here',
};

const RUN_PATHS: Record<string, string> = {
  bare: '',
  root: '/',
  nested: '/a/b?x=1',
};

const requests: ProbeRequest[] = [
  ...Object.entries(CLOUDFUNCTIONS_PATHS).map(([key, path]) => ({
    id: `cloudfunctions-${key}`,
    function: 'pyricHttpEcho',
    via: 'cloudfunctions' as const,
    path,
  })),
  ...Object.entries(RUN_PATHS).map(([key, path]) => ({
    id: `run-${key}`,
    function: 'pyricHttpEcho',
    via: 'run' as const,
    path,
  })),
];

/** functions-http#4: the path a handler sees under each production URL. */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-onrequest-subpath',
  matrixRow: 'functions-http #4',
  rowIds: ['functions-http#4'],
  description:
    'The req.path, req.url, req.originalUrl, and req.baseUrl a v2 onRequest handler sees for paths after the function name, on cloudfunctions.net and on the run.app URL.',
  requests,
  behavior(responses) {
    return Object.fromEntries(
      requests.map(({ id }) => {
        const response = responses[id];
        const echo = response.status === 200 ? echoOf(response) : null;
        return [id, {
          status: response.status,
          path: echo?.path ?? null,
          url: echo?.url ?? null,
          originalUrl: echo?.originalUrl ?? null,
          baseUrl: echo?.baseUrl ?? null,
        }];
      }),
    );
  },
};
