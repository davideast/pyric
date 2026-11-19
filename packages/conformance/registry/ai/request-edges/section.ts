import { defineRowSection } from '../../section-rows.ts';

/**
 * AI Logic request rows backed by the App Check and AI Logic hunt's
 * production captures (`ai-request-edge-`, from
 * src/ai-request-edge-probes.ts: raw generateContent in the @firebase/ai
 * request shape with an App Check token).
 */
const REPLAY = 'packages/pyric/test/ai/hunt-captures.test.ts';
const WORKER_REPLAY = 'packages/cli/test/serve/worker/ai-request-edges.test.ts';
const APP_SCENARIO = 'test/apps/ai-sandbox-contents-roles/scenario.ts';
const SEC_REQUEST_EDGES = 'Requests checked against production captures';

export const section = defineRowSection({
  surface: 'ai',
  order: 80,
  prefix: `## ${SEC_REQUEST_EDGES}\n\nEach row cites a production capture from the App Check and AI Logic hunt and replays across in-process, SharedWorker, and Node-hosted planes.\n`,
  defaults: {
    section: SEC_REQUEST_EDGES,
    status: 'conforms',
    automation: 'oracle-backed',
    conformanceTests: [REPLAY, WORKER_REPLAY, APP_SCENARIO],
    risk: ['error-code'],
    riskScore: 2,
    riskReasons: ['asserts production HTTP status and error status that can drift on re-capture'],
  },
});

export const row = section.row;
