import {
  callableBody,
  callableShape,
  reportOf,
  type FunctionsCallableWireProbe,
} from '../../src/capture/functions-callable/probe-types.ts';

/**
 * functions-callable#12: `consumeAppCheckToken` reports `alreadyConsumed`
 * false for the first use of a limited-use token and true for the second, and
 * what it reports for a regular token.
 */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-app-check-consume',
  matrixRow: 'functions-callable #12',
  rowIds: ['functions-callable#12'],
  description:
    'An onCall with enforceAppCheck and consumeAppCheckToken called twice with one limited-use token, then twice with one regular token.',
  requests: [
    { id: 'limited-first', function: 'pyricCallableConsume', via: 'cloudfunctions', tokens: { appCheck: 'limited-use-shared' }, ...callableBody({}) },
    { id: 'limited-second', function: 'pyricCallableConsume', via: 'cloudfunctions', tokens: { appCheck: 'limited-use-shared' }, ...callableBody({}) },
    { id: 'regular-first', function: 'pyricCallableConsume', via: 'cloudfunctions', tokens: { appCheck: 'valid' }, ...callableBody({}) },
    { id: 'regular-second', function: 'pyricCallableConsume', via: 'cloudfunctions', tokens: { appCheck: 'valid' }, ...callableBody({}) },
  ],
  behavior(responses) {
    const view = (id: string) => {
      const app = reportOf(responses[id])?.app ?? null;
      return app ? { status: responses[id].status, app } : callableShape(responses[id]);
    };
    return Object.fromEntries(Object.keys(responses).map((id) => [id, view(id)]));
  },
};
