import { callableBody, callableShape, type FunctionsCallableWireProbe } from '../../src/capture/functions-callable/probe-types.ts';

const MODES = ['throw-plain', 'reject-plain', 'throw-string'];

/** functions-callable#4: a throw that is not an HttpsError becomes 500 `INTERNAL`. */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-plain-throw',
  matrixRow: 'functions-callable #4',
  rowIds: ['functions-callable#4'],
  description: 'A v2 and a v1 onCall that throw an Error, return a rejected promise, and throw a string.',
  requests: MODES.flatMap((mode) => [
    { id: `v2-${mode}`, function: 'pyricCallableEcho', via: 'cloudfunctions' as const, ...callableBody({ mode }) },
    { id: `v1-${mode}`, function: 'pyricCallableV1', via: 'cloudfunctions' as const, ...callableBody({ mode }) },
  ]),
  behavior(responses) {
    return Object.fromEntries(Object.keys(responses).map((id) => [id, callableShape(responses[id])]));
  },
};
