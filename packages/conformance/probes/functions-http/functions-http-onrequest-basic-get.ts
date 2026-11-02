import { echoOf, type FunctionsHttpProbe } from '../../src/capture/functions-http/probe-types.ts';

/**
 * functions-http#1 and #3: a v2 onRequest export answers at its URL, and the
 * handler sees the method, the parsed query, and the request headers,
 * including the names of the headers the platform adds.
 */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-onrequest-basic-get',
  matrixRow: 'functions-http #1, #3',
  rowIds: ['functions-http#1', 'functions-http#3'],
  description:
    'GET, PUT, and DELETE reach a v2 onRequest echo handler with the method, query (repeated and bracketed keys), and request headers it reports.',
  requests: [
    {
      id: 'get',
      function: 'pyricHttpEcho',
      via: 'cloudfunctions',
      path: '?alpha=1&list=a&list=b&nested[k]=v',
      headers: { 'x-pyric-probe': 'basic-get', accept: 'application/json' },
    },
    { id: 'put', function: 'pyricHttpEcho', via: 'cloudfunctions', method: 'PUT', path: '?verb=put' },
    { id: 'delete', function: 'pyricHttpEcho', via: 'cloudfunctions', method: 'DELETE' },
  ],
  behavior(responses) {
    const get = echoOf(responses.get);
    return {
      get: {
        status: responses.get.status,
        contentType: responses.get.headers['content-type'] ?? null,
        method: get.method,
        query: get.query,
        headerValues: get.headerValues,
        headerNames: get.headerNames,
      },
      put: { status: responses.put.status, method: echoOf(responses.put).method, query: echoOf(responses.put).query },
      delete: { status: responses.delete.status, method: echoOf(responses.delete).method },
    };
  },
};
