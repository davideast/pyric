import { withoutRunValues, type FunctionsCallableClientProbe } from '../../src/capture/functions-callable/probe-types.ts';

/**
 * functions-callable#17, client side: `getFunctions(app, origin)` with the
 * Hosting origin as the custom domain calls `<origin>/pyricCallableEcho`,
 * which the hosting rewrite serves.
 */
export const probe: FunctionsCallableClientProbe = {
  kind: 'client',
  name: 'functions-callable-client-custom-domain',
  matrixRow: 'functions-callable #17',
  rowIds: ['functions-callable#17'],
  description: 'firebase/functions in a page on the Hosting origin calling httpsCallable(getFunctions(app, location.origin), "pyricCallableEcho").',
  scenario: 'customDomain',
  appCheck: false,
  behavior(result) {
    return withoutRunValues(result) as Record<string, unknown>;
  },
};
