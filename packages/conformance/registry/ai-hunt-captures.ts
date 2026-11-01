import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilityTableBlock } from './types.ts';

/**
 * AI Logic request rows backed by the App Check and AI Logic hunt's
 * production captures (`ai-request-edge-`, from
 * src/ai-request-edge-probes.ts: raw generateContent in the @firebase/ai
 * request shape with an App Check token). Each row is a `bug`: the replay in
 * REPLAY pins production's answer and pyric's under the hunt's finding ID
 * until its fix removes the pin.
 */
const REPLAY = 'packages/pyric/test/ai/hunt-captures.test.ts';

export const SEC_REQUEST_EDGES = 'Requests checked against production captures';

const captureRow = defineRows({
  surface: 'ai',
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

export const aiHuntRows: CompatibilityRow[] = [
  captureRow({
    rowRef: 'request-roleless-contents',
    featureKeys: ['generateContent'],
    api: 'generateContent({ contents: [{ parts }] }) with no role',
    behavior: "AI-21: production answers contents with no role (200); pyric refuses it (400, Role '' is not supported).",
    notes: 'Production answered with finish reason STOP and a candidate with role `model`.',
    evidence: '`oracle:ai-request-edge-roleless-contents`.',
    oracleObservations: ['ai-request-edge-roleless-contents'],
  }),
  captureRow({
    rowRef: 'request-string-system-instruction',
    featureKeys: ['startChat', 'generateContent'],
    api: "startChat({ systemInstruction: 'text' }).sendMessage(prompt)",
    behavior: 'AI-22: production refuses a string systemInstruction from startChat (400 INVALID_ARGUMENT); pyric answers.',
    notes: "Production's message: `Invalid value at 'system_instruction' (type.googleapis.com/google.ai.generativelanguage.v1beta.Content)`. The real SDK sends the string unchanged from `startChat`; `getGenerativeModel` wraps it in a Content.",
    evidence: '`oracle:ai-request-edge-string-system-instruction`.',
    oracleObservations: ['ai-request-edge-string-system-instruction'],
  }),
  captureRow({
    rowRef: 'request-model-gemini-pro',
    featureKeys: ['getGenerativeModel', 'generateContent'],
    api: "getGenerativeModel(ai, { model: 'gemini-pro' }).generateContent(prompt)",
    behavior: 'AI-23: production refuses the model gemini-pro (404 NOT_FOUND); pyric answers.',
    notes: 'Production gives the unknown-model message: `models/gemini-pro is not found for API version v1main, ...`.',
    evidence: '`oracle:ai-request-edge-model-gemini-pro`.',
    oracleObservations: ['ai-request-edge-model-gemini-pro'],
  }),
];

export const aiHuntBlock: CompatibilityTableBlock = {
  kind: 'table',
  prefix: `## ${SEC_REQUEST_EDGES}\n\nEach row cites a production capture from the App Check and AI Logic hunt. A \`bug\` row states production's behavior and pyric's; its replay holds both answers until the fix lands.\n`,
  rows: aiHuntRows,
};
