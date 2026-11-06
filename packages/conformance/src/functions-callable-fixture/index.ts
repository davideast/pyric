/**
 * What the functions-callable conformance suite in `packages/cli` replays: the
 * rows, the probes, the request sender the capture harness uses, the page
 * program the client probes run, and the directory holding the unchanged
 * fixture codebase, its firebase.json, and public/.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export { functionsCallableRows } from '../../registry/functions-callable.ts';
export { functionsCallableProbes } from '../capture/functions-callable/probes.ts';
export { CALLABLE_BROWSER_SOURCE } from '../capture/functions-callable/browser-source.ts';
export { probeUrl, sendProbe, sendProbeRequest, type ProbeTargets } from '../capture/functions-http/send.ts';
export {
  callableBody,
  reportOf,
  type AppCheckTokenKind,
  type AuthTokenKind,
  type CallableProbeRequest,
  type CallableReport,
  type ClientScenarioInput,
  type FunctionsCallableClientProbe,
  type FunctionsCallableProbe,
  type FunctionsCallableWireProbe,
  type ProbeResponse,
} from '../capture/functions-callable/probe-types.ts';

/** `firebase.json`, `fixture/` (the codebase), and `public/`, exactly as the capture deploys them. */
export const functionsCallableCaptureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'capture',
  'functions-callable',
);
