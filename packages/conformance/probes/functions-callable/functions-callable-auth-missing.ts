import {
  callableBody,
  reportOf,
  type FunctionsCallableWireProbe,
} from '../../src/capture/functions-callable/probe-types.ts';

/** functions-callable#7: with no Authorization header the call is served and `auth` is undefined. */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-auth-missing',
  matrixRow: 'functions-callable #7',
  rowIds: ['functions-callable#7'],
  description: 'A v2 and a v1 onCall echo called with no Authorization header.',
  requests: [
    { id: 'v2', function: 'pyricCallableEcho', via: 'cloudfunctions', ...callableBody({}) },
    { id: 'v1', function: 'pyricCallableV1', via: 'cloudfunctions', ...callableBody({}) },
  ],
  behavior(responses) {
    const view = (id: string) => ({ status: responses[id].status, auth: reportOf(responses[id])?.auth ?? null });
    return { v2: view('v2'), v1: view('v1') };
  },
};
