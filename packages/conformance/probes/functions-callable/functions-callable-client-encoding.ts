import { withoutRunValues, type FunctionsCallableClientProbe } from '../../src/capture/functions-callable/probe-types.ts';

/**
 * functions-callable#2, client side: what `httpsCallable` sends for a Date, a
 * large integer, NaN, Infinity, and undefined data, and what it decodes from
 * each value the handler returns.
 */
export const probe: FunctionsCallableClientProbe = {
  kind: 'client',
  name: 'functions-callable-client-encoding',
  matrixRow: 'functions-callable #2',
  rowIds: ['functions-callable#2'],
  description:
    'firebase/functions in Chromium calling the echo with a Date, 2^53 + 1, NaN, Infinity, and undefined, and with each return mode.',
  scenario: 'encoding',
  appCheck: false,
  behavior(result) {
    return withoutRunValues(result) as Record<string, unknown>;
  },
};
