import { withoutRunValues, type FunctionsCallableClientProbe } from '../../src/capture/functions-callable/probe-types.ts';

/**
 * functions-callable#16: `httpsCallableFromURL` reaches the same v2 callable
 * through its `cloudfunctions.net` URL and through its `run.app` URL.
 */
export const probe: FunctionsCallableClientProbe = {
  kind: 'client',
  name: 'functions-callable-client-from-url',
  matrixRow: 'functions-callable #16',
  rowIds: ['functions-callable#16'],
  description:
    'firebase/functions in Chromium calling pyricCallableEcho with httpsCallableFromURL at https://us-central1-<project>.cloudfunctions.net/pyricCallableEcho and at its run.app URL.',
  scenario: 'fromUrl',
  appCheck: false,
  behavior(result) {
    return withoutRunValues(result) as Record<string, unknown>;
  },
};
