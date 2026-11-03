import {
  callableBody,
  callableShape,
  reportOf,
  type FunctionsCallableWireProbe,
} from '../../src/capture/functions-callable/probe-types.ts';

/** functions-callable#10: `enforceAppCheck` refuses a missing or invalid token with 401 and serves a valid one. */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-app-check-enforced',
  matrixRow: 'functions-callable #10',
  rowIds: ['functions-callable#10'],
  description:
    'An onCall with enforceAppCheck: true called with no X-Firebase-AppCheck header, an invalid value, and a token minted from the run debug token.',
  requests: [
    { id: 'missing', function: 'pyricCallableEnforced', via: 'cloudfunctions', ...callableBody({}) },
    { id: 'invalid', function: 'pyricCallableEnforced', via: 'cloudfunctions', tokens: { appCheck: 'invalid' }, ...callableBody({}) },
    { id: 'valid', function: 'pyricCallableEnforced', via: 'cloudfunctions', tokens: { appCheck: 'valid' }, ...callableBody({}) },
  ],
  behavior(responses) {
    return {
      missing: callableShape(responses.missing),
      invalid: callableShape(responses.invalid),
      valid: { status: responses.valid.status, app: reportOf(responses.valid)?.app ?? null },
    };
  },
};
