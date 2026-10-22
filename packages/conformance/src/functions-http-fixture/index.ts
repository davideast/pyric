/**
 * What the functions-http conformance suite in `packages/cli` replays: the
 * rows, the probes, the request sender the capture harness uses, and the
 * directory holding the unchanged fixture codebase and its firebase.json.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export { functionsHttpRows } from '../../registry/functions-http.ts';
export { functionsHttpProbes } from '../capture/functions-http/probes.ts';
export { probeUrl, sendProbe, sendProbeRequest, type ProbeTargets } from '../capture/functions-http/send.ts';
export type {
  EchoReport,
  FunctionsHttpProbe,
  ProbeRequest,
  ProbeResponse,
} from '../capture/functions-http/probe-types.ts';

/** `firebase.json`, `fixture/` (the codebase), and `public/`, exactly as the capture deploys them. */
export const functionsHttpCaptureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'capture',
  'functions-http',
);
