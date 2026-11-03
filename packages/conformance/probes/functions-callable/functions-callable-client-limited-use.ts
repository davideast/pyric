import { withoutRunValues, type FunctionsCallableClientProbe } from '../../src/capture/functions-callable/probe-types.ts';

/**
 * functions-callable#20: with `limitedUseAppCheckTokens: true` each call sends
 * a fresh limited-use token, so a consuming callable reports
 * `alreadyConsumed: false` every time; without it the cached token is sent
 * again and the second call reports `true`.
 */
export const probe: FunctionsCallableClientProbe = {
  kind: 'client',
  name: 'functions-callable-client-limited-use',
  matrixRow: 'functions-callable #20',
  rowIds: ['functions-callable#20', 'functions-callable#12'],
  description:
    'firebase/functions with App Check (debug provider) in Chromium calling pyricCallableConsume twice with limitedUseAppCheckTokens: true, twice without it, and pyricCallableEnforced once.',
  scenario: 'limitedUse',
  appCheck: true,
  behavior(result) {
    return withoutRunValues(result) as Record<string, unknown>;
  },
};
