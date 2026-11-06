import {
  callableBody,
  callableShape,
  type AuthTokenKind,
  type FunctionsCallableWireProbe,
} from '../../src/capture/functions-callable/probe-types.ts';

const KINDS: AuthTokenKind[] = ['forged', 'garbage', 'basic'];

/**
 * functions-callable#8: a forged ID token, a value that is not a JWT, and a
 * non-Bearer scheme are refused with 401 `UNAUTHENTICATED` before the handler
 * runs. The wrong-audience case is stated from firebase-admin source on the
 * row, not captured (no second project).
 */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-auth-invalid',
  matrixRow: 'functions-callable #8',
  rowIds: ['functions-callable#8'],
  description:
    'A v2 and a v1 onCall echo called with a real ID token whose signature was altered, a non-JWT Bearer value, and an Authorization: Basic header.',
  requests: KINDS.flatMap((auth) => [
    { id: `v2-${auth}`, function: 'pyricCallableEcho', via: 'cloudfunctions' as const, tokens: { auth }, ...callableBody({}) },
    { id: `v1-${auth}`, function: 'pyricCallableV1', via: 'cloudfunctions' as const, tokens: { auth }, ...callableBody({}) },
  ]),
  behavior(responses) {
    return Object.fromEntries(Object.keys(responses).map((id) => [id, callableShape(responses[id])]));
  },
};
