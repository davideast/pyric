import {
  callableBody,
  reportOf,
  type FunctionsCallableWireProbe,
} from '../../src/capture/functions-callable/probe-types.ts';

/**
 * functions-callable#11: without `enforceAppCheck`, a call with an invalid
 * token is served with `app` undefined, and a valid token still reaches the
 * handler as `request.app`.
 */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-app-check-unenforced',
  matrixRow: 'functions-callable #11',
  rowIds: ['functions-callable#11'],
  description:
    'A v2 onCall echo with no App Check option called with no token, an invalid token, and a valid token, and the v1 echo with a valid token.',
  requests: [
    { id: 'missing', function: 'pyricCallableEcho', via: 'cloudfunctions', ...callableBody({}) },
    { id: 'invalid', function: 'pyricCallableEcho', via: 'cloudfunctions', tokens: { appCheck: 'invalid' }, ...callableBody({}) },
    { id: 'valid', function: 'pyricCallableEcho', via: 'cloudfunctions', tokens: { appCheck: 'valid' }, ...callableBody({}) },
    { id: 'v1-valid', function: 'pyricCallableV1', via: 'cloudfunctions', tokens: { appCheck: 'valid' }, ...callableBody({}) },
  ],
  behavior(responses) {
    const view = (id: string) => ({ status: responses[id].status, app: reportOf(responses[id])?.app ?? null });
    return { missing: view('missing'), invalid: view('invalid'), valid: view('valid'), v1Valid: view('v1-valid') };
  },
};
