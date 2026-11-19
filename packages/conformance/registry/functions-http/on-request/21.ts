import { SUITE, VITE_PLANE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 210,
  kind: 'pyric',
  api: 'onRequest execution record',
  behavior:
    'Each request a function serves lands one execution record with an http cause (method, path, status); in browser mode the first slice records it as a log line.',
  evidence:
    'Pyric-owned. Owner decision: log lines only, in browser mode, for the first slice; no `execution_finished` event on the sandbox stream yet. The line names the export, method, path, status, and duration (`packages/cli/src/functions/http/report.ts`); both planes print one per request.',
  flip: { status: 'conforms', tests: [SUITE, 'packages/cli/test/functions-http/gateway.test.ts', VITE_PLANE] },
});
