import { defineRowSection } from '../../section-rows.ts';

/**
 * AI Logic request rows backed by the App Check and AI Logic hunt's
 * production captures (`ai-request-edge-`, from
 * src/ai-request-edge-probes.ts: raw generateContent in the @firebase/ai
 * request shape with an App Check token). Each row is a `bug`: the replay in
 * REPLAY pins production's answer and pyric's under the hunt's finding ID
 * until its fix removes the pin.
 */
const REPLAY = 'packages/pyric/test/ai/hunt-captures.test.ts';
const SEC_REQUEST_EDGES = 'Requests checked against production captures';

export const section = defineRowSection({
  surface: 'ai',
  order: 80,
  prefix: `## ${SEC_REQUEST_EDGES}\n\nEach row cites a production capture from the App Check and AI Logic hunt. A \`bug\` row states production's behavior and pyric's; its replay holds both answers until the fix lands.\n`,
  defaults: {
    section: SEC_REQUEST_EDGES,
    status: 'bug',
    automation: 'oracle-backed',
    conformanceDisposition: 'pending-fix',
    conformanceTests: [REPLAY],
    risk: ['error-code'],
    riskScore: 2,
    riskReasons: ['asserts production HTTP status and error status that can drift on re-capture'],
  },
});

export const row = section.row;
