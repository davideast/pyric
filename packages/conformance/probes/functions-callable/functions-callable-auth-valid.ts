import {
  callableBody,
  reportOf,
  type FunctionsCallableWireProbe,
} from '../../src/capture/functions-callable/probe-types.ts';

/**
 * functions-callable#6: a valid ID token gives v2 `request.auth` and v1
 * `context.auth` with the claim names production's verifyIdToken returns.
 */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-auth-valid',
  matrixRow: 'functions-callable #6',
  rowIds: ['functions-callable#6'],
  description:
    "A v2 and a v1 onCall echo called with a fresh ID token for the run's test user, signed in with a custom token; the report keeps claim names and the iss and aud forms only.",
  requests: [
    { id: 'v2', function: 'pyricCallableEcho', via: 'cloudfunctions', tokens: { auth: 'valid' }, ...callableBody({}) },
    { id: 'v1', function: 'pyricCallableV1', via: 'cloudfunctions', tokens: { auth: 'valid' }, ...callableBody({}) },
  ],
  behavior(responses) {
    const view = (id: string) => ({ status: responses[id].status, auth: reportOf(responses[id])?.auth ?? null });
    return { v2: view('v2'), v1: view('v1') };
  },
};
