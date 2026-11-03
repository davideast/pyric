import { withoutRunValues, type FunctionsCallableClientProbe } from '../../src/capture/functions-callable/probe-types.ts';

/**
 * functions-callable#14, client side: `.stream()` yields each chunk, resolves
 * `data` with the result, rejects both on an error frame, and a plain call to
 * a streaming function gets the result with `sendChunk` returning false.
 */
export const probe: FunctionsCallableClientProbe = {
  kind: 'client',
  name: 'functions-callable-client-stream',
  matrixRow: 'functions-callable #14',
  rowIds: ['functions-callable#14'],
  description:
    'firebase/functions in Chromium calling pyricCallableStream with .stream() (succeeding, with a heartbeat pause, and failing after one chunk) and as a plain call.',
  scenario: 'stream',
  appCheck: false,
  behavior(result) {
    return withoutRunValues(result) as Record<string, unknown>;
  },
};
