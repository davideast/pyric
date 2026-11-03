import { withoutRunValues, type FunctionsCallableClientProbe } from '../../src/capture/functions-callable/probe-types.ts';

/**
 * functions-callable#6 and #7, client side: after `signInWithCustomToken`,
 * `httpsCallable` attaches the user's ID token so v2 and v1 handlers see
 * `auth`; after `signOut` the next call carries none.
 */
export const probe: FunctionsCallableClientProbe = {
  kind: 'client',
  name: 'functions-callable-client-signed-in',
  matrixRow: 'functions-callable #6',
  rowIds: ['functions-callable#6', 'functions-callable#7'],
  description:
    "firebase/auth and firebase/functions in Chromium: sign in as the run's test user, call the v2 and v1 echo, sign out, call the v2 echo again.",
  scenario: 'signedIn',
  appCheck: false,
  behavior(result) {
    return withoutRunValues(result) as Record<string, unknown>;
  },
};
