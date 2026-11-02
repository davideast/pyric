import { echoOf, type FunctionsHttpProbe } from '../../src/capture/functions-http/probe-types.ts';

/** functions-http#2: a v1 `functions.https.onRequest` export is served like a v2 one. */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-onrequest-v1',
  matrixRow: 'functions-http #2',
  rowIds: ['functions-http#2'],
  description:
    'A v1 https.onRequest echo function (default region) answering a GET at its root and under a path, and a JSON POST.',
  requests: [
    { id: 'root', function: 'pyricHttpV1', via: 'cloudfunctions', path: '?v=1' },
    { id: 'nested', function: 'pyricHttpV1', via: 'cloudfunctions', path: '/a/b?x=1' },
    {
      id: 'post-json',
      function: 'pyricHttpV1',
      via: 'cloudfunctions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"v":1}',
    },
  ],
  behavior(responses) {
    const view = (id: string) => {
      const echo = responses[id].status === 200 ? echoOf(responses[id]) : null;
      return {
        status: responses[id].status,
        method: echo?.method ?? null,
        path: echo?.path ?? null,
        url: echo?.url ?? null,
        query: echo?.query ?? null,
        body: echo?.body ?? null,
      };
    };
    return { root: view('root'), nested: view('nested'), postJson: view('post-json') };
  },
};
