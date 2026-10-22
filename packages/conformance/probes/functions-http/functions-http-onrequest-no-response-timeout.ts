import { statusShape, type FunctionsHttpProbe } from '../../src/capture/functions-http/probe-types.ts';

const TIMEOUT_SECONDS = 5;

/** functions-http#11: a handler that never responds, cut at `timeoutSeconds`. */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-onrequest-no-response-timeout',
  matrixRow: 'functions-http #11',
  rowIds: ['functions-http#11'],
  description:
    'A v2 onRequest handler with timeoutSeconds: 5 that never responds, on both production URLs: the status, body, and how long the client waited.',
  requests: [
    { id: 'cloudfunctions', function: 'pyricHttpTimeout', via: 'cloudfunctions', clientTimeoutMs: 60_000 },
    { id: 'run', function: 'pyricHttpTimeout', via: 'run', clientTimeoutMs: 60_000 },
  ],
  behavior(responses) {
    const cut = (id: string) => ({
      ...statusShape(responses[id]),
      cutAfterTimeout: responses[id].elapsedMs >= TIMEOUT_SECONDS * 1_000,
      cutWithinTwiceTimeout: responses[id].elapsedMs < TIMEOUT_SECONDS * 2_000,
    });
    return { timeoutSeconds: TIMEOUT_SECONDS, cloudfunctions: cut('cloudfunctions'), run: cut('run') };
  },
};
