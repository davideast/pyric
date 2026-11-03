import {
  callableBody,
  callableShape,
  type FunctionsCallableWireProbe,
} from '../../src/capture/functions-callable/probe-types.ts';

/**
 * functions-callable#17: a firebase.json hosting rewrite to a callable
 * (`/pyricCallableEcho`) serves the callable protocol on the Hosting origin,
 * the URL `getFunctions(app, origin)` builds.
 */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-hosting-rewrite',
  matrixRow: 'functions-callable #17',
  rowIds: ['functions-callable#17'],
  description:
    'A callable POST, a thrown HttpsError, and a GET through the Hosting rewrite /pyricCallableEcho -> pyricCallableEcho.',
  requests: [
    { id: 'call', function: 'pyricCallableEcho', via: 'hosting', path: '/pyricCallableEcho', ...callableBody({ via: 'hosting' }) },
    {
      id: 'https-error',
      function: 'pyricCallableEcho',
      via: 'hosting',
      path: '/pyricCallableEcho',
      ...callableBody({ mode: 'throw', code: 'failed-precondition', message: 'through hosting', details: { via: 'hosting' } }),
    },
    { id: 'get', function: 'pyricCallableEcho', via: 'hosting', path: '/pyricCallableEcho', method: 'GET' },
  ],
  behavior(responses) {
    return Object.fromEntries(Object.keys(responses).map((id) => [id, callableShape(responses[id])]));
  },
};
