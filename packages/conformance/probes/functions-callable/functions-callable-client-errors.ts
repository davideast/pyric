import { withoutRunValues, type FunctionsCallableClientProbe } from '../../src/capture/functions-callable/probe-types.ts';

/**
 * functions-callable#18: the FunctionsError a page sees for each HttpsError
 * code, a plain throw, a missing App Check token on an enforced function, and
 * a function name the project does not define.
 */
export const probe: FunctionsCallableClientProbe = {
  kind: 'client',
  name: 'functions-callable-client-errors',
  matrixRow: 'functions-callable #18',
  rowIds: ['functions-callable#18'],
  description:
    'firebase/functions in Chromium: the name, code, message, details, and customData keys of each rejected httpsCallable call.',
  scenario: 'errors',
  appCheck: false,
  behavior(result) {
    return withoutRunValues(result) as Record<string, unknown>;
  },
};
