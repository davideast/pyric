import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/hunt-captures.test.ts';

export default row({
  order: 20,
  featureKeys: ['startChat', 'generateContent'],
  api: "startChat({ systemInstruction: 'text' }).sendMessage(prompt) and raw wire string systemInstruction",
  behavior:
    'Formats string and `Part` `systemInstruction` inputs into `Content` objects inside `ChatSession` (matching `@firebase/ai` 2.16.0 in `firebase` 12.19.0 so `startChat({ systemInstruction: "text" })` succeeds), while the Gemini wire broker rejects raw non-`Content` `systemInstruction` values with 400 `INVALID_ARGUMENT` and `BadRequest` `fieldViolations`.',
  notes:
    "Production's wire refusal on a raw string `systemInstruction` is `Invalid value at 'system_instruction' (type.googleapis.com/google.ai.generativelanguage.v1beta.Content)`; `@firebase/ai` 2.16.0 (`firebase` 12.19.0) wraps `StartChatParams.systemInstruction` via `formatSystemInstruction` in `ChatSession`.",
  evidence:
    'Capture `ai-request-edge-string-system-instruction` replayed at the wire/worker boundary alongside `@firebase/ai` 2.16.0 `ChatSession` formatting across in-process (`hunt-captures.test.ts`), worker-host (`ai-request-edges.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: ['ai-request-edge-string-system-instruction'],
  conformanceChecks: [
    {
      finding: 'AI-22',
      observation: 'ai-request-edge-string-system-instruction',
      expect: {
        httpStatus: 400,
        errorStatus: 'INVALID_ARGUMENT',
        detailTypes: ['type.googleapis.com/google.rpc.BadRequest'],
      },
      probe: PROBE,
      guards:
        'Raw wire string systemInstruction fails 400 INVALID_ARGUMENT while ChatSession wraps StartChatParams.systemInstruction into Content.',
    },
  ],
});
