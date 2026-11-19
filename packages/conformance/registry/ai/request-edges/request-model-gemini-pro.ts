import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/hunt-captures.test.ts';

export default row({
  order: 30,
  featureKeys: ['getGenerativeModel', 'generateContent', 'generateContentStream', 'countTokens'],
  api: "getGenerativeModel(ai, { model: 'gemini-pro' }).generateContent(prompt)",
  behavior:
    'Rejects `gemini-pro` with 404 `NOT_FOUND` (`models/gemini-pro is not found for API version v1main, ...`) after App Check admission across unary, streaming, and `countTokens` calls, emitting `request_rejected` on the sandbox and worker brokers.',
  notes:
    'Production gives the unknown-model message `models/gemini-pro is not found for API version v1main, ...` after verifying the App Check header.',
  evidence:
    'Capture `ai-request-edge-model-gemini-pro` replayed across in-process (`hunt-captures.test.ts`), worker-host (`ai-request-edges.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: ['ai-request-edge-model-gemini-pro'],
  conformanceChecks: [
    {
      finding: 'AI-23',
      observation: 'ai-request-edge-model-gemini-pro',
      expect: { httpStatus: 404, errorStatus: 'NOT_FOUND', detailTypes: [] },
      probe: PROBE,
      guards:
        'Model gemini-pro fails 404 NOT_FOUND after App Check admission and emits request_rejected across planes.',
    },
  ],
});
